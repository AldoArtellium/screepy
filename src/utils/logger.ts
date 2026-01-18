/**
 * Centralized logging system with configurable log levels.
 *
 * Log levels can be set in-game via Memory.logLevel:
 *   Memory.logLevel = 3; // DEBUG - show all
 *   Memory.logLevel = 2; // INFO - normal operation (default)
 *   Memory.logLevel = 1; // WARN - only warnings and errors
 *   Memory.logLevel = 0; // ERROR - only errors
 */

export enum LogLevel {
    ERROR = 0,
    WARN = 1,
    INFO = 2,
    DEBUG = 3
}

class Logger {
    /**
     * Gets the current log level from Memory, defaulting to DEBUG.
     */
    private getLevel(): LogLevel {
        return Memory.logLevel ?? LogLevel.INFO;
    }

    /**
     * Formats a log message with timestamp and module prefix.
     */
    private format(level: string, module: string, args: any[]): string {
        const tick = Game.time;
        const message = args
            .map((arg) => (typeof arg === "object" ? JSON.stringify(arg) : String(arg)))
            .join(" ");
        return `[${tick}] [${level}] [${module}] ${message}`;
    }

    /**
     * Log debug messages (level 3) - detailed debugging information.
     */
    debug(module: string, ...args: any[]): void {
        if (this.getLevel() >= LogLevel.DEBUG) {
            console.log(this.format("DEBUG", module, args));
        }
    }

    /**
     * Log info messages (level 2) - normal operational messages.
     */
    info(module: string, ...args: any[]): void {
        if (this.getLevel() >= LogLevel.INFO) {
            console.log(this.format("INFO", module, args));
        }
    }

    /**
     * Log warning messages (level 1) - warning conditions, potential problems.
     */
    warn(module: string, ...args: any[]): void {
        if (this.getLevel() >= LogLevel.WARN) {
            console.log(this.format("WARN", module, args));
        }
    }

    /**
     * Log error messages (level 0) - critical failures that need immediate attention.
     */
    error(module: string, ...args: any[]): void {
        if (this.getLevel() >= LogLevel.ERROR) {
            console.log(this.format("ERROR", module, args));
        }
    }

    /**
     * Convenience method to set the log level from in-game console.
     */
    setLevel(level: LogLevel): void {
        Memory.logLevel = level;
        console.log(`Log level set to ${LogLevel[level]} (${level})`);
    }
}

export const log = new Logger();
