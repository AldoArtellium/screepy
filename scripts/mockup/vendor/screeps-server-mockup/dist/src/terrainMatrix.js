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
Object.defineProperty(exports, "__esModule", { value: true });
const _ = __importStar(require("lodash"));
const TYPES = ['plain', 'wall', 'swamp'];
class Matrix {
    data;
    /**
        Constructor
    */
    constructor() {
        this.data = {};
    }
    /**
        Getters
    */
    get(x, y) {
        return _.get(this.data, `${x}:${y}`, 'plain');
    }
    /**
        Setters
    */
    set(x, y, value) {
        if (TYPES.includes(value)) {
            _.set(this.data, `${x}:${y}`, value);
        }
        else {
            throw new Error(`invalid value ${value}`);
        }
        return this;
    }
    /**
        Serialize the terrain for database storage
    */
    serialize() {
        let str = '';
        for (let y = 0; y < 50; y += 1) {
            for (let x = 0; x < 50; x += 1) {
                const terrain = this.get(x, y);
                const mask = TYPES.indexOf(terrain);
                if (mask !== -1) {
                    str += mask;
                }
                else {
                    throw new Error(`invalid terrain type: ${terrain}`);
                }
            }
        }
        return str;
    }
    /**
        Return a string representation of the matrix
    */
    static unserialize(str) {
        const matrix = new Matrix();
        _.each(str.split(''), (mask, idx) => {
            const x = idx % 50;
            const y = Math.floor(idx / 50);
            const terrain = _.get(TYPES, mask);
            if (terrain == null) {
                throw new Error(`invalid terrain mask: ${mask}`);
            }
            else if (terrain !== 'plain') {
                matrix.set(x, y, terrain);
            }
        });
        return matrix;
    }
}
exports.default = Matrix;
