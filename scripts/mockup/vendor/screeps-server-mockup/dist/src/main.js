"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TerrainMatrix = exports.stdHooks = exports.ScreepsServer = void 0;
const screepsServer_1 = __importDefault(require("./screepsServer"));
exports.ScreepsServer = screepsServer_1.default;
const terrainMatrix_1 = __importDefault(require("./terrainMatrix"));
exports.TerrainMatrix = terrainMatrix_1.default;
/* eslint @typescript-eslint/no-var-requires: "off" */
const stdHooks = require('../utils/stdhooks');
exports.stdHooks = stdHooks;
