import type { Component } from "@earendil-works/pi-tui";

/**
 * Generic prop-driven component contract. Every renderable owns its own `P` shape;
 * the adapter computes `P` from canonical state via per-component selectors and
 * pushes it via `setProps`. `focused: boolean` is a field on `P` only where the
 * component needs it.
 */
export interface StatefulView<P> extends Component {
  setProps(props: P): void;
}

/**
 * Re-exported, never redeclared. Which surface owns the keyboard is canonical
 * state: the key router's cascade and the reducer's defensive clears are what
 * enforce mutual exclusion, and components only read the result. Per-component
 * `focused` flags derive from one equality check against this discriminant
 * rather than from parallel booleans.
 */
export type { ActiveView } from "../state/state.js";
