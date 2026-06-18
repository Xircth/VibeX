import { useEffect, useState, useCallback } from 'react';

interface VideoProgress {
  /** Callback ref to attach to the <video> element. */
  setVideoRef: (node: HTMLVideoElement | null) => void;
  /** The currently attached element, for imperative use (e.g. replay). */
  videoEl: HTMLVideoElement | null;
  isLoading: boolean;
  playedPercent: number; // 0-100
  bufferedPercent: number; // 0-100
  duration: number; // in seconds
}

/**
 * Track video loading state and playback/buffering progress.
 *
 * Uses a callback ref (not a passed-in RefObject) so the listener effect
 * re-runs whenever the actual <video> element mounts/unmounts/changes. A
 * RefObject dependency never re-runs the effect, so listeners failed to attach
 * when the element appeared after the first render (e.g. media switching from
 * image to video), leaving `isLoading` stuck at `true`.
 */
export function useVideoProgress(): VideoProgress {
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [playedPercent, setPlayedPercent] = useState(0);
  const [bufferedPercent, setBufferedPercent] = useState(0);
  const [duration, setDuration] = useState(0);

  const setVideoRef = useCallback((node: HTMLVideoElement | null) => {
    setVideoEl(node);
  }, []);

  useEffect(() => {
    const video = videoEl;
    if (!video) return;

    const handleLoadedMetadata = () => {
      setDuration(video.duration);
    };

    const handleCanPlay = () => {
      setIsLoading(false);
    };

    const handleWaiting = () => {
      setIsLoading(true);
    };

    const handleTimeUpdate = () => {
      if (video.duration) {
        setPlayedPercent((video.currentTime / video.duration) * 100);
      }
    };

    const handleProgress = () => {
      if (video.duration && video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        setBufferedPercent((bufferedEnd / video.duration) * 100);
      }
    };

    video.addEventListener('loadedmetadata', handleLoadedMetadata);
    video.addEventListener('canplay', handleCanPlay);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('progress', handleProgress);

    return () => {
      video.removeEventListener('loadedmetadata', handleLoadedMetadata);
      video.removeEventListener('canplay', handleCanPlay);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('progress', handleProgress);
    };
  }, [videoEl]);

  return {
    setVideoRef,
    videoEl,
    isLoading,
    playedPercent,
    bufferedPercent,
    duration,
  };
}
