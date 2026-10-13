// What an action's form asks a person for (pure; tested in action-form.test.ts). The action's input is a JSON Schema
// subset (src/lib/server/ops/types.ts) with two hints for forms:
// - "x-groups" on the input, "x-group" on a field: alternative ways to give the same thing (a .zip upload, a .zip in
//   S3, a container image). The form shows one group at a time (F42); a group may be offered only when a property of
//   the resource says so (`ifProp` / `unlessProp`: "Package type" = "Container image").
// - "x-echo" on a field: the confirming request copies it from the dry run's `plan.echo` (the state the plan was made
//   against, R04). A person is never asked for it.

export interface Schema {
  type?: "object" | "string" | "integer" | "number" | "boolean" | "array";
  title?: string;
  description?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  enum?: (string | number)[];
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: Schema;
  maxItems?: number;
  default?: unknown;
  "x-group"?: string; // the field belongs to one of the input's x-groups
  "x-groups"?: XGroup[]; // on the action's input: alternative ways to give it (pick one)
  "x-echo"?: boolean; // filled from the plan's echo, never shown
}

export interface XGroup {
  id: string;
  title: string;
  ifProp?: { label: string; value: string }; // offered only when the resource's property says so
  unlessProp?: { label: string; value: string };
}

// The groups this resource is offered ("Package type: Container image" → only the image group).
export function groupsFor(schema: Schema, props: readonly { label: string; value: string }[]): XGroup[] {
  const prop = (label: string) => props.find((p) => p.label === label)?.value;
  return (schema["x-groups"] ?? []).filter((g) => (!g.ifProp || prop(g.ifProp.label) === g.ifProp.value) && (!g.unlessProp || prop(g.unlessProp.label) !== g.unlessProp.value));
}

// The fields a person fills in: the chosen group's and the ungrouped ones (all of them when the input has no groups),
// never an x-echo field. Validation and the request carry nothing else.
export function formSchema(schema: Schema, group: string | undefined): Schema {
  const grouped = !!schema["x-groups"]?.length;
  const props = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([, f]) => f["x-echo"] !== true && (!grouped || !f["x-group"] || f["x-group"] === group)));
  return { ...schema, properties: props, required: (schema.required ?? []).filter((n) => Object.hasOwn(props, n)) };
}

// Does the action ask a person for anything at all (in any group)?
export const hasFields = (schema: Schema) => Object.values(schema.properties ?? {}).some((f) => f["x-echo"] !== true);
