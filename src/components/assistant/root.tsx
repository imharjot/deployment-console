"use client";
// Where the shell mounts the assistant: the drawer's code loads the first time it opens (it pulls in the run view,
// plan cards and evidence), so no page pays for it until someone asks.
import dynamic from "next/dynamic";
import { AnimatePresence } from "motion/react";
import { closeAssistant, useAssistant } from "./store";

const AssistantDrawer = dynamic(() => import("./drawer"), { ssr: false });

export function AssistantRoot() {
  const { open } = useAssistant();
  return <AnimatePresence>{open && <AssistantDrawer key="assistant" onClose={closeAssistant} />}</AnimatePresence>;
}
