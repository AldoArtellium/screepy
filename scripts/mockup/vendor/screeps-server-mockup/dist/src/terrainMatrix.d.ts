type TerrainTypes = 'plain' | 'wall' | 'swamp';
export default class Matrix {
    private data;
    /**
        Constructor
    */
    constructor();
    /**
        Getters
    */
    get(x: number, y: number): TerrainTypes;
    /**
        Setters
    */
    set(x: number, y: number, value: TerrainTypes): this;
    /**
        Serialize the terrain for database storage
    */
    serialize(): string;
    /**
        Return a string representation of the matrix
    */
    static unserialize(str: string): Matrix;
}
export {};
