import TerrainMatrix from './terrainMatrix';
import User, { UserBadge } from './user';
import ScreepsServer from './screepsServer';
interface AddBotOptions {
    username: string;
    room: string;
    x: number;
    y: number;
    gcl?: number;
    cpu?: number;
    cpuAvailable?: number;
    active?: number;
    spawnName?: string;
    modules?: {};
}
export default class World {
    private server;
    /**
        Constructor
    */
    constructor(server: ScreepsServer);
    /**
        Getters
    */
    get gameTime(): Promise<number>;
    /**
        Connect to server (if needed) and return constants, database, env and pubsub objects
    */
    load(): Promise<{
        C: any;
        db: any;
        env: any;
        pubsub: any;
    }>;
    /**
        Set room status (and create it if needed)
        This function does NOT generate terrain data
    */
    setRoom(room: string, status?: string, active?: boolean): Promise<void>;
    /**
        Simplified alias for setRoom()
    */
    addRoom(room: string): Promise<void>;
    /**
        Return room terrain data (walls, plains and swamps)
        Return a TerrainMatrix instance
    */
    getTerrain(room: string): Promise<TerrainMatrix>;
    /**
        Define room terrain data (walls, plains and swamps)
        @terrain must be an instance of TerrainMatrix.
    */
    setTerrain(room: string, terrain?: TerrainMatrix): Promise<void>;
    /**
        Add a RoomObject to the specified room
        Returns db operation result
    */
    addRoomObject(room: string, type: string, x: number, y: number, attributes?: {}): Promise<any>;
    /**
        Reset world data to a barren world with no rooms, but with invaders and source keepers users
    */
    reset(): Promise<void>;
    /**
        Stub a basic world by adding 9 plausible rooms with sources, minerals and controllers
    */
    stubWorld(): Promise<void>;
    /**
        Get the roomObjects list for requested roomName
    */
    roomObjects(roomName: string): Promise<any[]>;
    /**
        Generate a random badge for a user.
        Taken from https://github.com/screeps/backend-local/blob/master/lib/cli/bots.js#L37.
     */
    genRandomBadge(): UserBadge;
    /**
        Add a new user to the world
    */
    addBot({ username, room, x, y, gcl, cpu, cpuAvailable, active, spawnName, modules }: AddBotOptions): Promise<User>;
    private updateEnvTerrain;
}
export {};
