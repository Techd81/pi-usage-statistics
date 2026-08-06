/**
 * Pure domain layer barrel. Consumers (storage, web, TUI) import from here —
 * the domain never imports terminal, HTTP, or DOM code.
 */
export * from "./types";
export * from "./normalize";
export * from "./pricing";
export * from "./aggregate";
export * from "./dedupe";
