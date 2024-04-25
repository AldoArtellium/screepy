class Claimer {
    public static run(creep: Creep) {
        const targetRoom = creep.memory.targetRoom as string;
        if (creep.room.name !== targetRoom) {
            // Move to the target room to claim
            const exitDir = creep.room.findExitTo(targetRoom) as ExitConstant;
            const exit = creep.pos.findClosestByRange(exitDir) as RoomPosition;
            creep.moveTo(exit);
        } else {
            // Claim the controller
            if (creep.room.controller && creep.claimController(creep.room.controller) === ERR_NOT_IN_RANGE) {
                creep.moveTo(creep.room.controller);
            }
        }
    }
}

export default Claimer;
