// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CollaborationModeOption } from "../../../types";
import { useCollaborationModeSelection } from "./useCollaborationModeSelection";

const planMode: CollaborationModeOption = {
  id: "plan",
  label: "Plan",
  mode: "plan",
  model: "gpt-5",
  reasoningEffort: null,
  developerInstructions: "Focus on planning",
  value: {
    mode: "plan",
    ask_on_blocker: true,
    settings: {
      native_guard: "strict",
    },
  },
};

describe("useCollaborationModeSelection", () => {
  it("builds payload from selected mode and current model/effort", () => {
    const { result } = renderHook(() =>
      useCollaborationModeSelection({
        selectedCollaborationMode: planMode,
        selectedCollaborationModeId: "plan",
        selectedEffort: "high",
        resolvedModel: "openai/gpt-5.3-codex",
      }),
    );

    expect(result.current.collaborationModePayload).toEqual({
      ask_on_blocker: true,
      mode: "plan",
      settings: {
        native_guard: "strict",
        developer_instructions: "Focus on planning",
        model: "openai/gpt-5.3-codex",
        reasoning_effort: "high",
      },
    });
  });

  it("returns null when mode selection is incomplete", () => {
    const { result } = renderHook(() =>
      useCollaborationModeSelection({
        selectedCollaborationMode: null,
        selectedCollaborationModeId: null,
        selectedEffort: null,
        resolvedModel: null,
      }),
    );

    expect(result.current.collaborationModePayload).toBeNull();
  });

  it("falls back to selected mode id when mode object is not loaded", () => {
    const { result } = renderHook(() =>
      useCollaborationModeSelection({
        selectedCollaborationMode: null,
        selectedCollaborationModeId: "plan",
        selectedEffort: "medium",
        resolvedModel: "openai/gpt-5.3-codex",
      }),
    );

    expect(result.current.collaborationModePayload).toEqual({
      mode: "plan",
      settings: {
        developer_instructions: null,
        model: "openai/gpt-5.3-codex",
        reasoning_effort: "medium",
      },
    });
  });

  it("keeps existing developer instructions from backend mode payload", () => {
    const { result } = renderHook(() =>
      useCollaborationModeSelection({
        selectedCollaborationMode: {
          ...planMode,
          developerInstructions: "ui-fallback",
          value: {
            mode: "plan",
            settings: {
              developer_instructions: "server-native",
              native_guard: "strict",
            },
          },
        },
        selectedCollaborationModeId: "plan",
        selectedEffort: null,
        resolvedModel: null,
      }),
    );

    expect(result.current.collaborationModePayload).toEqual({
      mode: "plan",
      settings: {
        developer_instructions: "server-native",
        native_guard: "strict",
      },
    });
  });
});
