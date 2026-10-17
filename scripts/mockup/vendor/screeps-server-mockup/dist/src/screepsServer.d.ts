import * as cp from 'child_process';
import { EventEmitter } from 'events';
import World from './world';
export interface ScreepServerOptions {
    path: string;
    logdir: string;
    port: number;
    modfile?: string;
}
export default class ScreepsServer extends EventEmitter {
    driver: any;
    config: any;
    common: any;
    constants: any;
    connected: boolean;
    processes: {
        [name: string]: cp.ChildProcess;
    };
    world: World;
    private usersQueue?;
    private roomsQueue?;
    private opts;
    constructor(opts?: Partial<ScreepServerOptions>);
    private computeDefaultOpts;
    setOpts(opts: ScreepServerOptions): this;
    getOpts(): ScreepServerOptions;
    connect(): Promise<this>;
    tick(): Promise<this>;
    startProcess(name: string, execPath: string, env: NodeJS.ProcessEnv): Promise<cp.ChildProcess>;
    start(): Promise<this>;
    stop(): this;
}
