import { AtomRegistry } from "effect/reactivity";

/** The registry every atom in the app is read through, in React and outside it. */
export const appAtomRegistry = AtomRegistry.make();
