import { TypedEmitter } from "tiny-typed-emitter";

import { resolvePermissionSet } from "../../utils/misc";
import {
    AdministrationRights,
    ByondRights,
    ChatBotRights,
    ConfigurationRights,
    DreamDaemonRights,
    DreamMakerRights,
    ErrorCode as TGSErrorCode,
    InstanceManagerRights,
    InstancePermissionSetRights,
    RepositoryRights,
    RightsType
} from "../generatedcode/_enums";
import InstanceClient from "../InstanceClient";
import InstancePermissionSetClient from "../InstancePermissionSetClient";
import JobsClient, { tgsJobResponse } from "../JobsClient";
import InternalError, { ErrorCode } from "../models/InternalComms/InternalError";
import { StatusCode } from "../models/InternalComms/InternalStatus";
import ServerClient from "../ServerClient";
import UserClient from "../UserClient";
import configOptions from "./config";
import LoginHooks from "./LoginHooks";

interface IEvents {
    jobsLoaded: () => unknown;
}

export default new (class JobsController extends TypedEmitter<IEvents> {
    private fastmodecount = 0;
    public set fastmode(cycles: number) {
        console.log(`JobsController going in fastmode for ${cycles} cycles`);
        this.fastmodecount = cycles;
        this.restartLoop();
    }

    private currentLoop: Date = new Date(0);
    private accessibleInstances = new Set<number>();

    public errors: InternalError[] = [];
    public jobs = new Map<number, tgsJobResponse>();
    public jobsByInstance = new Map<number, Map<number, tgsJobResponse>>();

    public reset() {
        this.jobs = new Map<number, tgsJobResponse>();
        this.jobsByInstance = new Map<number, Map<number, tgsJobResponse>>();
        this.reloadAccessibleInstances()
            .then(this.restartLoop)
            .catch(e => {
                this.errors.push(new InternalError(ErrorCode.APP_FAIL, { jsError: Error(e) }));
            });
    }

    public constructor() {
        super();

        this.loop = this.loop.bind(this);
        this.reset = this.reset.bind(this);
        this.restartLoop = this.restartLoop.bind(this);
    }

    public init() {
        window.clients["JobsController"] = this;

        //technically not a "cache" but we might as well reload it
        ServerClient.on("purgeCache", this.reset);

        InstanceClient.on("instanceChange", this.reset);
        // eslint-disable-next-line @typescript-eslint/require-await
        LoginHooks.addHook(async () => this.reset());
    }

    private async reloadAccessibleInstances(loop = false): Promise<void> {
        const allInstances = await InstanceClient.listInstances();
        if (allInstances.code === StatusCode.ERROR) {
            this.errors.push(allInstances.error);
            return;
        }

        const updatedSet = new Set<number>();

        const work = allInstances.payload
            .filter(instance => instance.online)
            .map(instance => {
                return InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    instance.id
                ).then(permissionSet => {
                    if (permissionSet.code === StatusCode.ERROR) {
                        //If its access denied, it means we have view all instances but we dont have access to the instance itself
                        if (permissionSet.error.code !== ErrorCode.HTTP_ACCESS_DENIED) {
                            this.errors.push(permissionSet.error);
                        }
                        return;
                    }
                    updatedSet.add(instance.id);
                });
            });

        await Promise.all(work);

        this.accessibleInstances = updatedSet;

        if (loop) {
            window.setTimeout(
                () => void this.reloadAccessibleInstances(true),
                configOptions.instanceprobetimer.value as number
            );
        }
    }

    public restartLoop() {
        //we use an actual date object here because it could help prevent really weird timing
        // issues as two different date objects cannot be equal
        // despite the date being
        const initDate = new Date(Date.now());
        this.currentLoop = initDate;
        window.setTimeout(() => {
            this.loop(initDate).catch(e =>
                this.errors.push(new InternalError(ErrorCode.APP_FAIL, { jsError: Error(e) }))
            );
        }, 0);
    }

    private async loop(loopid: Date) {
        //so loops get initialiazed with the current time, it keeps track of which loop to run with
        // that initialization date in currentLoop if the currentLoop isnt equal to the one provided
        // to the loop, it means that the loop was
        // replaced so we dont try to call for another one
        if (loopid !== this.currentLoop) {
            return;
        }

        //time to clear out errors
        this.errors = [];

        let totalActiveJobs = 0;
        const work: Promise<void>[] = [];

        this.accessibleInstances.forEach(instanceid => {
            //now since this is async, it still possible that a single fire gets done after the new loop started, theres no really much that can be done about it
            work.push(
                JobsClient.listActiveJobs(instanceid)
                    .then(async value => {
                        //this check is here because the request itself is async and could return after
                        // the loop is terminated, we dont want to contaminate the jobs of an instance
                        // with the jobs of another even if it is for a single fire and would eventually
                        // get fixed on its own after a few seconds
                        if (loopid !== this.currentLoop) return;

                        if (value.code === StatusCode.OK) {
                            const instanceSet = this.jobsByInstance.get(instanceid) || new Map();
                            this.jobsByInstance.set(instanceid, instanceSet);
                            for (const job of value.payload) {
                                instanceSet.set(job.id, job);
                                this.jobs.set(job.id, job);
                            }

                            const remoteActive = value.payload.map(job => job.id);
                            const localActive = Array.from(this.jobs.values())
                                .filter(job => !job.stoppedAt)
                                .filter(job => job.instanceid === instanceid)
                                .map(job => job.id);
                            const manualIds = localActive.filter(
                                jobId => !remoteActive.includes(jobId)
                            );

                            const work: Promise<void>[] = [];
                            manualIds.forEach(jobId => {
                                work.push(
                                    JobsClient.getJob(instanceid, jobId).then(job => {
                                        if (job.code === StatusCode.ERROR) {
                                            this.errors.push(job.error);
                                            return;
                                        }
                                        instanceSet.set(job.payload.id, job.payload);
                                        this.jobs.set(job.payload.id, job.payload);
                                    })
                                );
                            });
                            await Promise.all(work);

                            if (loopid !== this.currentLoop) return;

                            totalActiveJobs += value.payload.length;
                        } else {
                            if (
                                value.error.code === ErrorCode.HTTP_DATA_INEGRITY &&
                                value.error.originalErrorMessage?.errorCode ===
                                    TGSErrorCode.InstanceOffline
                            ) {
                                console.log(
                                    `[JobsController] Clearing instance ${instanceid} as it is now offline`
                                );
                                this.accessibleInstances.delete(instanceid);
                                //Probably a good idea to reload the list at this point
                                this.reloadAccessibleInstances().catch(e => {
                                    this.errors.push(
                                        new InternalError(ErrorCode.APP_FAIL, { jsError: Error(e) })
                                    );
                                });
                            } else {
                                this.errors.push(value.error);
                            }
                        }
                    })
                    .catch(reason => {
                        console.error(reason);
                    })
            );
        });

        await Promise.all(work);

        work.length = 0;
        for (const job of this.jobs.values()) {
            if (
                job.progress === undefined &&
                !job.stoppedAt &&
                this.accessibleInstances.has(job.instanceid)
            ) {
                work.push(
                    JobsClient.getJob(job.instanceid, job.id).then(progressedjob => {
                        if (loopid !== this.currentLoop) return;
                        if (progressedjob.code === StatusCode.OK) {
                            job.progress = progressedjob.payload.progress;
                        } else {
                            if (
                                progressedjob.error.code === ErrorCode.HTTP_DATA_INEGRITY &&
                                progressedjob.error.originalErrorMessage?.errorCode ===
                                    TGSErrorCode.InstanceOffline
                            ) {
                                console.log(
                                    `[JobsController] Clearing instance ${job.instanceid} as it is now offline`
                                );
                                this.accessibleInstances.delete(job.instanceid);
                                //Probably a good idea to reload the list at this point
                                this.reloadAccessibleInstances().catch(e => {
                                    this.errors.push(
                                        new InternalError(ErrorCode.APP_FAIL, { jsError: Error(e) })
                                    );
                                });
                            } else {
                                this.errors.push(progressedjob.error);
                            }
                        }
                    })
                );
            }

            work.push(
                this.canCancel(job, this.errors).then(canCancel => {
                    if (loopid !== this.currentLoop) return;
                    job.canCancel = canCancel;
                })
            );
        }

        //populate fields on jobs
        await Promise.all(work);
        if (loopid !== this.currentLoop) return;

        this.emit("jobsLoaded");
        if (this.fastmodecount && loopid === this.currentLoop) {
            window.setTimeout(() => {
                this.loop(loopid).catch(e =>
                    this.errors.push(new InternalError(ErrorCode.APP_FAIL, { jsError: Error(e) }))
                );
            }, 800);
            this.fastmodecount--;
            console.log(`JobsController will remain in fastmode for ${this.fastmodecount} cycles`);
        } else {
            window.setTimeout(() => {
                this.loop(loopid).catch(e =>
                    this.errors.push(new InternalError(ErrorCode.APP_FAIL, { jsError: Error(e) }))
                );
            }, (totalActiveJobs ? (configOptions.jobpollactive.value as number) : (configOptions.jobpollinactive.value as number)) * 1000);
        }
    }

    private async canCancel(
        job: Readonly<tgsJobResponse>,
        errors: InternalError<ErrorCode>[]
    ): Promise<boolean> {
        //we dont need to reevalutate stuff that we already know
        if (job.canCancel !== undefined) return job.canCancel;

        if (job.cancelRightsType === undefined) {
            return true;
        }

        switch (job.cancelRightsType as RightsType) {
            case RightsType.Administration: {
                const userInfo = await UserClient.getCurrentUser();
                if (userInfo.code === StatusCode.OK) {
                    const required = job.cancelRight as AdministrationRights;
                    return !!(
                        resolvePermissionSet(userInfo.payload).administrationRights & required
                    );
                } else {
                    errors.push(userInfo.error);
                    return false;
                }
            }
            case RightsType.InstanceManager: {
                const userInfo = await UserClient.getCurrentUser();
                if (userInfo.code === StatusCode.OK) {
                    const required = job.cancelRight as InstanceManagerRights;
                    return !!(
                        resolvePermissionSet(userInfo.payload).instanceManagerRights & required
                    );
                } else {
                    errors.push(userInfo.error);
                    return false;
                }
            }
            case RightsType.Byond: {
                const InstancePermissionSet = await InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    job.instanceid
                );
                if (InstancePermissionSet.code === StatusCode.OK) {
                    const required = job.cancelRight as ByondRights;
                    return !!(InstancePermissionSet.payload.byondRights & required);
                } else {
                    errors.push(InstancePermissionSet.error);
                    return false;
                }
            }
            case RightsType.ChatBots: {
                const InstancePermissionSet = await InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    job.instanceid
                );
                if (InstancePermissionSet.code === StatusCode.OK) {
                    const required = job.cancelRight as ChatBotRights;
                    return !!(InstancePermissionSet.payload.chatBotRights & required);
                } else {
                    errors.push(InstancePermissionSet.error);
                    return false;
                }
            }
            case RightsType.Configuration: {
                const InstancePermissionSet = await InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    job.instanceid
                );
                if (InstancePermissionSet.code === StatusCode.OK) {
                    const required = job.cancelRight as ConfigurationRights;
                    return !!(InstancePermissionSet.payload.configurationRights & required);
                } else {
                    errors.push(InstancePermissionSet.error);
                    return false;
                }
            }
            case RightsType.DreamDaemon: {
                const InstancePermissionSet = await InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    job.instanceid
                );
                if (InstancePermissionSet.code === StatusCode.OK) {
                    const required = job.cancelRight as DreamDaemonRights;
                    return !!(InstancePermissionSet.payload.dreamDaemonRights & required);
                } else {
                    errors.push(InstancePermissionSet.error);
                    return false;
                }
            }
            case RightsType.DreamMaker: {
                const InstancePermissionSet = await InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    job.instanceid
                );
                if (InstancePermissionSet.code === StatusCode.OK) {
                    const required = job.cancelRight as DreamMakerRights;
                    return !!(InstancePermissionSet.payload.dreamMakerRights & required);
                } else {
                    errors.push(InstancePermissionSet.error);
                    return false;
                }
            }
            case RightsType.InstancePermissionSet: {
                const InstancePermissionSet = await InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    job.instanceid
                );
                if (InstancePermissionSet.code === StatusCode.OK) {
                    const required = job.cancelRight as InstancePermissionSetRights;
                    return !!(InstancePermissionSet.payload.instancePermissionSetRights & required);
                } else {
                    errors.push(InstancePermissionSet.error);
                    return false;
                }
            }
            case RightsType.Repository: {
                const InstancePermissionSet = await InstancePermissionSetClient.getCurrentInstancePermissionSet(
                    job.instanceid
                );
                if (InstancePermissionSet.code === StatusCode.OK) {
                    const required = job.cancelRight as RepositoryRights;
                    return !!(InstancePermissionSet.payload.repositoryRights & required);
                } else {
                    errors.push(InstancePermissionSet.error);
                    return false;
                }
            }
        }
    }

    public async cancelOrClear(
        jobid: number,
        onError: (error: InternalError<ErrorCode>) => void
    ): Promise<boolean> {
        const job = this.jobs.get(jobid);

        //no we cant cancel jobs we arent aware of yet
        if (!job) return false;

        //just clear out the job
        if (job.stoppedAt) {
            this.jobsByInstance.get(job.instanceid)?.delete(jobid);
            this.jobs.delete(jobid);
            this.emit("jobsLoaded");
            return true;
        } else {
            const deleteInfo = await JobsClient.deleteJob(job.instanceid, jobid);
            if (deleteInfo.code === StatusCode.OK) {
                return true;
            } else {
                onError(deleteInfo.error);
                return false;
            }
        }
    }
})();
