import { createFileRoute } from "@tanstack/react-router";
import { RunnerSettings } from "../components/settings/RunnerSettings";
export const Route = createFileRoute("/settings/runner")({ component: RunnerSettings });
