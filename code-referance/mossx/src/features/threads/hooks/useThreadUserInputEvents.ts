import { useCallback, useRef } from "react";
import type { Dispatch } from "react";
import type { RequestUserInputRequest } from "../../../types";
import type { ThreadAction } from "./useThreadsReducer";

type UseThreadUserInputEventsOptions = {
  dispatch: Dispatch<ThreadAction>;
};

export function useThreadUserInputEvents({ dispatch }: UseThreadUserInputEventsOptions) {
  const completedRequestKeysRef = useRef<Set<string>>(new Set());

  return useCallback(
    (request: RequestUserInputRequest) => {
      const requestKey = `${request.workspace_id}:${String(request.request_id)}`;
      if (request.params.completed === true) {
        completedRequestKeysRef.current.add(requestKey);
        if (completedRequestKeysRef.current.size > 2048) {
          completedRequestKeysRef.current.clear();
          completedRequestKeysRef.current.add(requestKey);
        }
        dispatch({
          type: "removeUserInputRequest",
          requestId: request.request_id,
          workspaceId: request.workspace_id,
        });
        return;
      }
      if (completedRequestKeysRef.current.has(requestKey)) {
        return;
      }
      dispatch({ type: "addUserInputRequest", request });
    },
    [dispatch],
  );
}
