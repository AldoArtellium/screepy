import { Dashboard, Dial, Table } from "screeps-viz";

// Display the current CPU usage
function displayCpu() {
    const cpu = Game.cpu;
    const bucket = cpu.bucket;
    const limit = cpu.limit;
    const used = cpu.getUsed();
    Dashboard({
        widgets: [
            {
                pos: { x: 1, y: 1 },
                width: 10,
                height: 5,
                widget: Dial({
                    data: { value: used },
                    config: {
                        label: "CPU",
                        textStyle: { color: "white" },
                        foregroundStyle: { fill: "red" }
                    }
                })
            },
            {
                pos: { x: 1, y: 6 },
                width: 10,
                height: 5,
                widget: Dial({
                    data: { value: bucket },
                    config: {
                        label: "Bucket",
                        textStyle: { color: "white" },
                        foregroundStyle: { fill: "green" }
                    }
                })
            },
            {
                pos: { x: 1, y: 11 },
                width: 10,
                height: 5,
                widget: Dial({
                    data: { value: limit },
                    config: {
                        label: "Limit",
                        textStyle: { color: "white" },
                        foregroundStyle: { fill: "blue" }
                    }
                })
            }
        ]
    });
}

/*
interface PolyStyle {
     * Fill color in any web format, default is undefined (no fill).
    fill?: string | undefined;
     * Opacity value, default is 0.5.
    opacity?: number;
     * Stroke color in any web format, default is #ffffff (white).
    stroke?: string;
     * Stroke line width, default is 0.1.
    strokeWidth?: number;
     * Either undefined (solid line), dashed, or dotted. Default is undefined.
    lineStyle?: "dashed" | "dotted" | "solid" | undefined;
}
*/

export const displayBucketModule = {
    name: "displayBucket",
    fn: () => {
        displayCpu();
        },
    mandatory: false
};