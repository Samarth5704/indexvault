// Crosshair sync (DESIGN § 5): hovering one time-series chart shows the same
// date on every other chart in the group. Only user-driven moves are broadcast,
// so programmatic crosshairs never echo back and forth.

export function createSyncGroup() {
  const members = new Map(); // chart -> unsubscribe

  return {
    add(tc) {
      const off = tc.onCrosshair((info, fromUser) => {
        if (!fromUser) return;
        for (const other of members.keys()) {
          if (other === tc) continue;
          if (info) other.showCrosshairAt(info.time);
          else other.hideCrosshair();
        }
      });
      members.set(tc, off);
    },
    remove(tc) {
      members.get(tc)?.();
      members.delete(tc);
    },
    clear() {
      for (const off of members.values()) off();
      members.clear();
    },
  };
}
