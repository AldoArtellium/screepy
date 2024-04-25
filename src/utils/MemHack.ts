const MemHack = {
    memory: null as any as Memory,
    parseTime: -1,
    register() {
        const start = Game.cpu.getUsed();
        this.memory = Memory;
        const end = Game.cpu.getUsed();
        this.parseTime = end - start;
        this.memory = (RawMemory as any)._parsed;
    },
    pretick() {
        delete (global as any).Memory;
        (global as any).Memory = this.memory;
        (RawMemory as any)._parsed = this.memory;
    }
}

MemHack.register();

export default MemHack