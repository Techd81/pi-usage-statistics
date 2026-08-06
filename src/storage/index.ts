/**
 * Storage layer barrel: durable record store + global session scanner.
 * Consumers (extension, web, TUI) import from here.
 */
export * from "./record-store";
export * from "./session-index";
