
import { Dashboard, Table, Rectangle } from "screeps-viz";

export const displayCreepTable = () => {
    const data = Object.values(Memory.creeps).map(creep => [creep.role, creep?.state || "None", creep.targetId?.type || "None"]);
    const headers = ["Role", "State", "Target Type"];
    Dashboard({
        widgets: [
            {
                pos: { x: 1, y: 1 },
                width: headers.length * 5,
                height: 10,
                widget: Rectangle({
                    data: Table({
                        data,
                        config: {
                            headers,
                            label: "Creeps"
                        }
                    })
                })
            }
        ]
    });
}

export const displayCreepModule = {
    name: "displayCreep",
    fn: () => {
        displayCreepTable();
        }
};