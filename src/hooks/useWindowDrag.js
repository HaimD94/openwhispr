import { useState, useEffect } from "react";

export const useWindowDrag = () => {
  const [isDragging, setIsDragging] = useState(false);

  const handleMouseDown = (e) => {
    if (e.button === 0) {
      // Left mouse button
      setIsDragging(true);
      window.electronAPI.startWindowDrag?.();
      e.preventDefault();
    }
  };

  const handleMouseUp = () => {
    if (isDragging) {
      setIsDragging(false);
      window.electronAPI.stopWindowDrag?.();
    }
  };

  const handleClick = (e) => {
    // Prevent any click actions - use hotkey only
    e.preventDefault();
  };

  // While a drag is live the main process moves the window at 60fps to follow
  // the cursor, so a mouseup that never arrives leaves the pill glued to the
  // pointer -- it "runs away" across the screen and only a restart frees it.
  // A single mouseup listener is not enough to prevent that: the window is
  // being moved out from under the pointer while the button is down, and a
  // release delivered to another surface (or swallowed by a lost mouse
  // capture) never reaches this document at all.
  //
  // So the release is detected three ways, and any one of them ends the drag:
  // the mouseup itself; a pointer event that supersedes it; and -- the one that
  // cannot be lost -- the button state carried on every mousemove. `buttons`
  // is a live bitmask of what is physically held, so the first movement after a
  // missed release reports 0 and stops the drag even though no up event ever
  // came.
  useEffect(() => {
    if (!isDragging) return;

    const end = () => {
      setIsDragging(false);
      window.electronAPI.stopWindowDrag?.();
    };

    const handleMove = (event) => {
      if (event.buttons === 0) end();
    };

    document.addEventListener("mouseup", end);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
    document.addEventListener("mousemove", handleMove);
    // A drag interrupted by something taking over the desktop (a system dialog,
    // Win+Tab, the screen locking) produces no further pointer events here.
    window.addEventListener("blur", end);

    return () => {
      document.removeEventListener("mouseup", end);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      document.removeEventListener("mousemove", handleMove);
      window.removeEventListener("blur", end);
    };
  }, [isDragging]);

  return {
    isDragging,
    handleMouseDown,
    handleMouseUp,
    handleClick,
  };
};
