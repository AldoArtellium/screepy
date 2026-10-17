import { EventEmitter } from 'events';
import ScreepsServer from './screepsServer';
type Notification = {
    message: string;
    type: string;
    date: number;
    count: number;
    _id: string;
};
export interface UserBadge {
    type: number;
    color1: string;
    color2: string;
    color3: string;
    flip: boolean;
    param: number;
}
export default class User extends EventEmitter {
    private knownNotifications;
    private _id;
    private _username;
    private _server;
    /**
        Constructor
    */
    constructor(server: ScreepsServer, data: {
        _id: string;
        username: string;
    });
    /**
        Getters
    */
    get id(): string;
    get username(): string;
    get cpu(): Promise<number>;
    get cpuAvailable(): Promise<number>;
    get gcl(): Promise<number>;
    get rooms(): Promise<any>;
    get lastUsedCpu(): Promise<number>;
    get memory(): Promise<string>;
    get notifications(): Promise<Notification[]>;
    get newNotifications(): Promise<Notification[]>;
    get activeSegments(): Promise<number[]>;
    /**
        Return the content of user segments based on @list (the list of segments, ie: [0, 1, 2]).
    */
    getSegments(list: number[]): Promise<any[]>;
    /**
        Set a new console command to run next tick
    */
    console(cmd: string): Promise<any>;
    /**
        Return the current value of the requested user data
    */
    getData(name: string): Promise<any>;
    /**
        Initialise console events
    */
    init(): Promise<this>;
}
export {};
