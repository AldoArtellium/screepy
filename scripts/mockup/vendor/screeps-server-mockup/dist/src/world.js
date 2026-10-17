"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const _ = __importStar(require("lodash"));
const util = __importStar(require("util"));
const zlib = __importStar(require("zlib"));
const terrainMatrix_1 = __importDefault(require("./terrainMatrix"));
const user_1 = __importDefault(require("./user"));
// Terrain string for room completely filled with walls
const walled = '1'.repeat(2500);
class World {
    server;
    /**
        Constructor
    */
    constructor(server) {
        this.server = server;
    }
    /**
        Getters
    */
    get gameTime() {
        return this.load().then(({ env }) => env.get(env.keys.GAMETIME));
    }
    /**
        Connect to server (if needed) and return constants, database, env and pubsub objects
    */
    async load() {
        if (!this.server.connected)
            await this.server.connect();
        const { db, env, pubsub } = this.server.common.storage;
        const C = this.server.constants;
        return { C, db, env, pubsub };
    }
    /**
        Set room status (and create it if needed)
        This function does NOT generate terrain data
    */
    async setRoom(room, status = 'normal', active = true) {
        const { db } = this.server.common.storage;
        const data = await db.rooms.find({ _id: room });
        if (data.length > 0) {
            await db.rooms.update({ _id: room }, { $set: { status, active } });
        }
        else {
            await db.rooms.insert({ _id: room, status, active });
        }
        await this.server.driver.updateAccessibleRoomsList();
    }
    /**
        Simplified alias for setRoom()
    */
    async addRoom(room) {
        return this.setRoom(room);
    }
    /**
        Return room terrain data (walls, plains and swamps)
        Return a TerrainMatrix instance
    */
    async getTerrain(room) {
        const { db } = this.server.common.storage;
        // Load data
        const data = await db['rooms.terrain'].find({ room });
        // Check if data actually exists
        if (data.length === 0) {
            throw new Error(`room ${room} doesn't appear to have any terrain data`);
        }
        // Parse and return terrain data as a TerrainMatrix
        const serial = _.get(_.first(data), 'terrain');
        return terrainMatrix_1.default.unserialize(serial);
    }
    /**
        Define room terrain data (walls, plains and swamps)
        @terrain must be an instance of TerrainMatrix.
    */
    async setTerrain(room, terrain = new terrainMatrix_1.default()) {
        const { db, env } = this.server.common.storage;
        // Check parameters
        if (!(terrain instanceof terrainMatrix_1.default)) {
            throw new Error('@terrain must be an instance of TerrainMatrix');
        }
        // Insert or update data in database
        const data = await db['rooms.terrain'].find({ room });
        if (data.length > 0) {
            await db['rooms.terrain'].update({ room }, { $set: { terrain: terrain.serialize() } });
        }
        else {
            await db['rooms.terrain'].insert({ room, terrain: terrain.serialize() });
        }
        // Update environment cache
        await this.updateEnvTerrain(db, env);
    }
    /**
        Add a RoomObject to the specified room
        Returns db operation result
    */
    async addRoomObject(room, type, x, y, attributes = {}) {
        const { db } = this.server.common.storage;
        // Check parameters
        if (x < 0 || y < 0 || x >= 50 || y >= 50) {
            throw new Error('invalid x/y coordinates (they must be between 0 and 49)');
        }
        // Inject data into database
        const object = { ...{ room, x, y, type }, ...attributes };
        return db['rooms.objects'].insert(object);
    }
    /**
        Reset world data to a barren world with no rooms, but with invaders and source keepers users
    */
    async reset() {
        const { db, env } = await this.load();
        // Clear database
        await Promise.all(_.map(db, (col) => col.clear()));
        await env.set(env.keys.GAMETIME, 1);
        // Insert invaders and sourcekeeper users
        await Promise.all([
            db.users.insert({ _id: '2', username: 'Invader', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 }),
            db.users.insert({ _id: '3', username: 'Source Keeper', cpu: 100, cpuAvailable: 10000, gcl: 13966610.2, active: 0 })
        ]);
    }
    /**
        Stub a basic world by adding 9 plausible rooms with sources, minerals and controllers
    */
    async stubWorld() {
        // Clear database
        await this.reset();
        // Utility functions
        const addRoomObjects = (roomName, objects) => Promise.all(objects.map((o) => this.addRoomObject(roomName, o.type, o.x, o.y, o.attributes)));
        const addRoom = (roomName, terrain, roomObjects) => Promise.all([
            this.addRoom(roomName),
            this.setTerrain(roomName, terrain),
            addRoomObjects(roomName, roomObjects)
        ]);
        // Add rooms
        // eslint-disable-next-line global-require, import/no-unresolved
        const rooms = require('../../assets/rooms.json');
        await Promise.all(_.map(rooms, (data, roomName) => {
            const terrain = terrainMatrix_1.default.unserialize(data.serial);
            return addRoom(roomName, terrain, data.objects);
        }));
    }
    /**
        Get the roomObjects list for requested roomName
    */
    async roomObjects(roomName) {
        const { db } = await this.load();
        return db['rooms.objects'].find({ room: roomName });
    }
    /**
        Generate a random badge for a user.
        Taken from https://github.com/screeps/backend-local/blob/master/lib/cli/bots.js#L37.
     */
    genRandomBadge() {
        const badge = {
            type: Math.floor(Math.random() * 24) + 1,
            color1: `#${Math.floor(Math.random() * 0xffffff).toString(16)}`,
            color2: `#${Math.floor(Math.random() * 0xffffff).toString(16)}`,
            color3: `#${Math.floor(Math.random() * 0xffffff).toString(16)}`,
            flip: Math.random() > 0.5,
            param: Math.floor(Math.random() * 200) - 100,
        };
        return badge;
    }
    /**
        Add a new user to the world
    */
    async addBot({ username, room, x, y, gcl = 1, cpu = 100, cpuAvailable = 10000, active = 10000, spawnName = 'Spawn1', modules = {} }) {
        const { C, db, env } = await this.load();
        // Ensure that there is a controller in requested room
        const data = await db['rooms.objects'].findOne({ $and: [{ room }, { type: 'controller' }] });
        if (data == null) {
            throw new Error(`cannot add user in ${room}: room does not have any controller`);
        }
        // Insert user and update data
        const user = await db.users.insert({ username, cpu, cpuAvailable, gcl, active, badge: this.genRandomBadge() });
        await Promise.all([
            env.set(env.keys.MEMORY + user._id, '{}'),
            env.sadd(env.keys.ACTIVE_ROOMS, room),
            db.rooms.update({ _id: room }, { $set: { active: true } }),
            db['users.code'].insert({ user: user._id, branch: 'default', modules, activeWorld: true }),
            db['rooms.objects'].update({ room, type: 'controller' }, { $set: { user: user._id, level: 1, progress: 0, downgradeTime: null, safeMode: 20000 } }),
            db['rooms.objects'].insert({ room, type: 'spawn', x, y, user: user._id, name: spawnName, store: { energy: C.SPAWN_ENERGY_START }, storeCapacityResource: { energy: C.SPAWN_ENERGY_CAPACITY }, hits: C.SPAWN_HITS, hitsMax: C.SPAWN_HITS, spawning: null, notifyWhenAttacked: true }),
        ]);
        // Subscribe to console notificaiton and return emitter
        return new user_1.default(this.server, user).init();
    }
    async updateEnvTerrain(db, env) {
        const [rooms, terrain] = await Promise.all([
            db.rooms.find(),
            db['rooms.terrain'].find()
        ]);
        rooms.forEach((room) => {
            if (room.status === 'out of borders') {
                _.find(terrain, { room: room._id }).terrain = walled;
            }
            const m = room._id.match(/(W|E)(\d+)(N|S)(\d+)/);
            const roomH = m[1] + (+m[2] + 1) + m[3] + m[4];
            const roomV = m[1] + m[2] + m[3] + (+m[4] + 1);
            if (!_.some(terrain, { room: roomH })) {
                terrain.push({ room: roomH, terrain: walled });
            }
            if (!_.some(terrain, { room: roomV })) {
                terrain.push({ room: roomV, terrain: walled });
            }
        });
        const compressed = await util.promisify(zlib.deflate)(JSON.stringify(terrain));
        await env.set(env.keys.TERRAIN_DATA, compressed.toString('base64'));
    }
}
exports.default = World;
