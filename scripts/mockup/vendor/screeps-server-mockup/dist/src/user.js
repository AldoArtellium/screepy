"use strict";
/* eslint lines-between-class-members: "off" */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const events_1 = require("events");
const _ = __importStar(require("lodash"));
class User extends events_1.EventEmitter {
    knownNotifications;
    _id;
    _username;
    _server;
    /**
        Constructor
    */
    constructor(server, data) {
        super();
        this._id = data._id;
        this._username = data.username;
        this._server = server;
        this.knownNotifications = [];
    }
    /**
        Getters
    */
    get id() {
        return this._id;
    }
    get username() {
        return this._username;
    }
    get cpu() {
        return this.getData('cpu');
    }
    get cpuAvailable() {
        return this.getData('cpuAvailable');
    }
    get gcl() {
        return this.getData('gcl');
    }
    get rooms() {
        return this.getData('rooms');
    }
    get lastUsedCpu() {
        return this.getData('lastUsedCpu');
    }
    get memory() {
        const { env } = this._server.common.storage;
        return env.get(env.keys.MEMORY + this.id);
    }
    get notifications() {
        const { db } = this._server.common.storage;
        return db['users.notifications']
            .find({ user: this.id })
            .then((list) => list.map(({ message, type, date, count, _id }) => {
            this.knownNotifications.push(_id);
            return { message, type, date, count, _id };
        }));
    }
    get newNotifications() {
        const known = _.clone(this.knownNotifications);
        return this.notifications.then((list) => list.filter((notif) => !known.includes(notif._id)));
    }
    get activeSegments() {
        return this.getData('activeSegments');
    }
    /**
        Return the content of user segments based on @list (the list of segments, ie: [0, 1, 2]).
    */
    async getSegments(list) {
        const { env } = this._server.common.storage;
        return env.hmget(env.keys.MEMORY_SEGMENTS + this._id, list);
    }
    /**
        Set a new console command to run next tick
    */
    async console(cmd) {
        const { db } = this._server.common.storage;
        return db['users.console'].insert({ user: this._id, expression: cmd, hidden: false });
    }
    /**
        Return the current value of the requested user data
    */
    async getData(name) {
        const { db } = this._server.common.storage;
        const data = await db.users.find({ _id: this._id });
        return _.get(_.first(data), name);
    }
    /**
        Initialise console events
    */
    async init() {
        const { pubsub } = this._server.common.storage;
        await pubsub.subscribe(`user:${this._id}/console`, (event) => {
            const { messages } = JSON.parse(event);
            const { log = [], results = [] } = messages || {};
            this.emit('console', log, results, this._id, this.username);
        });
        return this;
    }
}
exports.default = User;
