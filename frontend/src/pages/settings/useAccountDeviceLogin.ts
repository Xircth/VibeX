import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AccountError,
  accountApi,
  openExternal,
  resolveCurrentHostIdentity,
  type DeviceLogin,
} from '@/features/model-router';

export function useAccountDeviceLogin(options: {
  isSignedIn: boolean;
  refresh: () => Promise<unknown>;
}) {
  const { isSignedIn, refresh } = options;
  const { t } = useTranslation(['settings', 'common']);

  const generation = useRef(0);
  const startingRef = useRef(false);
  const pollingController = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    []
  );

  const [loginState, setLoginState] = useState<{
    login: DeviceLogin;
    expiresAt: number;
  } | null>(null);
  const [startingLogin, setStartingLogin] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const describeError = useCallback(
    (cause: unknown) => {
      const code = cause instanceof AccountError ? cause.code : '';
      if (code === 'network')
        return t('settings:agents.modelRouterErrorNetwork');
      if (code === 'expired' || code === 'invalid') {
        return t('settings:agents.modelRouterErrorExpired');
      }
      if (code === 'denied') return t('settings:agents.modelRouterErrorDenied');
      if (code === 'signed_out') {
        return t('settings:agents.modelRouterErrorSignedOut');
      }
      if (!(cause instanceof AccountError) && cause instanceof Error) {
        return cause.message;
      }
      return t('settings:agents.modelRouterErrorFailed');
    },
    [t]
  );

  useEffect(() => {
    if (isSignedIn) {
      setLoginState(null);
      setAuthError(null);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (!loginState) return;
    let stopped = false;
    let timer: number | undefined;
    const controller = new AbortController();
    pollingController.current = controller;
    const expiryTimer = window.setTimeout(
      () => {
        stopped = true;
        controller.abort();
        window.clearTimeout(timer);
        setLoginState(null);
        setAuthError(t('settings:agents.modelRouterErrorExpired'));
      },
      Math.max(0, loginState.expiresAt - Date.now())
    );
    const poll = async () => {
      try {
        const approved = await accountApi.pollLogin(
          loginState.login,
          controller.signal
        );
        if (stopped) return;
        setAuthError(null);
        if (approved) {
          setLoginState(null);
          await refresh();
          return;
        }
      } catch (cause) {
        if (stopped) return;
        setAuthError(describeError(cause));
        if (!(cause instanceof AccountError) || cause.code !== 'network') {
          setLoginState(null);
          return;
        }
      }
      if (!stopped)
        timer = window.setTimeout(
          () => void poll(),
          Math.max(1, loginState.login.interval) * 1000
        );
    };
    timer = window.setTimeout(
      () => void poll(),
      Math.max(1, loginState.login.interval) * 1000
    );
    return () => {
      stopped = true;
      controller.abort();
      window.clearTimeout(timer);
      window.clearTimeout(expiryTimer);
    };
  }, [describeError, loginState, refresh, t]);

  const startLogin = useCallback(async () => {
    if (startingRef.current) return;
    startingRef.current = true;
    const attempt = ++generation.current;
    setStartingLogin(true);
    setAuthError(null);
    try {
      const identity = await resolveCurrentHostIdentity().catch(() => null);
      const next = await accountApi.startLogin(
        identity
          ? { deviceName: identity.hostName, hostId: identity.hostId }
          : undefined
      );
      if (generation.current !== attempt) return;
      setLoginState({
        login: next,
        expiresAt: Date.now() + next.expiresIn * 1000,
      });
      await openExternal(next.verifyUrl);
    } catch (cause) {
      setAuthError(describeError(cause));
    } finally {
      startingRef.current = false;
      setStartingLogin(false);
    }
  }, [describeError]);

  const cancelLogin = useCallback(() => {
    pollingController.current?.abort();
    generation.current += 1;
    setLoginState(null);
    setAuthError(null);
  }, []);

  const reopenVerifyUrl = useCallback(() => {
    if (!loginState) return;
    void openExternal(loginState.login.verifyUrl).catch((cause) =>
      setAuthError(describeError(cause))
    );
  }, [describeError, loginState]);

  return {
    loginState,
    startingLogin,
    authError,
    startLogin,
    cancelLogin,
    reopenVerifyUrl,
  };
}
