import { test } from "node:test";
import assert from "node:assert/strict";
import { formSchema, groupsFor, hasFields, type Schema } from "./action-form.ts";

const DEPLOY: Schema = {
  type: "object",
  required: ["s3Bucket", "imageUri"],
  "x-groups": [
    { id: "zip", title: "Upload a .zip", unlessProp: { label: "Package type", value: "Container image" } },
    { id: "s3", title: "A .zip in S3", unlessProp: { label: "Package type", value: "Container image" } },
    { id: "image", title: "Container image", ifProp: { label: "Package type", value: "Container image" } },
  ],
  properties: {
    zipBase64: { type: "string", "x-group": "zip" },
    s3Bucket: { type: "string", "x-group": "s3" },
    s3Key: { type: "string", "x-group": "s3" },
    imageUri: { type: "string", "x-group": "image" },
    publish: { type: "boolean" },
  },
};

test("F42: x-groups — the groups a resource is offered, and one group's fields at a time", () => {
  assert.deepEqual(groupsFor(DEPLOY, [{ label: "Runtime", value: "nodejs22.x" }]).map((g) => g.id), ["zip", "s3"], ".zip functions: upload or S3");
  assert.deepEqual(groupsFor(DEPLOY, [{ label: "Package type", value: "Container image" }]).map((g) => g.id), ["image"], "image functions: only the image field");
  const s3 = formSchema(DEPLOY, "s3");
  assert.deepEqual(Object.keys(s3.properties!), ["s3Bucket", "s3Key", "publish"]);
  assert.deepEqual(s3.required, ["s3Bucket"], "required only within the chosen group");
  assert.deepEqual(Object.keys(formSchema(DEPLOY, "image").properties!), ["imageUri", "publish"]);
  assert.deepEqual(groupsFor({ type: "object" }, []), []);
});

test("R04: an x-echo field comes from the plan, so the form never asks for it", () => {
  const deployImage: Schema = {
    type: "object",
    required: ["image"],
    properties: { image: { type: "string" }, container: { type: "string" }, expectedRevision: { type: "integer", "x-echo": true } },
  };
  assert.deepEqual(Object.keys(formSchema(deployImage, undefined).properties!), ["image", "container"]);
  assert.equal(formSchema(deployImage, undefined).properties!.expectedRevision, undefined);
  assert.equal(hasFields(deployImage), true);
  assert.equal(hasFields({ type: "object", properties: { expectedRevision: { type: "integer", "x-echo": true } } }), false, "only echoed fields: straight to the plan");
  assert.equal(hasFields({ type: "object" }), false);
});
