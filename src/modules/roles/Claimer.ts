class Claimer {
    static run(creep: Creep) {
        const targetRoom = creep.memory.targetRoom;

        // Validate targetRoom exists
        if (!targetRoom) {
            creep.say("❓");
            return;
        }

        if (creep.room.name !== targetRoom) {
            // Move to the target room to claim
            const exitDir = creep.room.findExitTo(targetRoom);

            // Handle error cases from findExitTo
            if (exitDir === ERR_NO_PATH || exitDir === ERR_INVALID_ARGS) {
                creep.say("❌");
                return;
            }

            // exitDir is now a valid direction constant (TOP, RIGHT, BOTTOM, LEFT)
            // which also works as FIND_EXIT_* constant
            const exit = creep.pos.findClosestByRange(exitDir as FindConstant);
            if (exit) {
                creep.moveTo(exit, { reusePath: 5 });
            }
        } else {
            // Claim the controller
            const controller = creep.room.controller;
            if (!controller) return;

            const result = creep.claimController(controller);
            if (result === ERR_NOT_IN_RANGE) {
                creep.moveTo(controller, { reusePath: 5 });
            } else if (result === ERR_GCL_NOT_ENOUGH) {
                // If we can't claim, try to reserve instead
                const reserveResult = creep.reserveController(controller);
                if (reserveResult === ERR_NOT_IN_RANGE) {
                    creep.moveTo(controller, { reusePath: 5 });
                }
            }
        }
    }
}

export default Claimer;
