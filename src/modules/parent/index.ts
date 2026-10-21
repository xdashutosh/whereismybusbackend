// Public surface of the parent module for other modules (notifications, tests):
//   effectivePreferences(tx, studentId, direction, parentIds)  per-parent toggles (missing rows = all on)
//   childRelay / CHILD_ROOM                                    the child:{studentId}:live feed and room
//   PARENT_SOCKET_EVENTS.CHILD_LIVE ('child:live')             event name in child rooms (@wimb/shared)
export { effectivePreferences, ALL_ON as DEFAULT_NOTIFICATION_TOGGLES } from './preferences.js';
export { childRelay, createChildRelay, CHILD_MOVING_EMIT_MS, CHILD_STOPPED_EMIT_MS, type ChildRelay } from './liveRelay.js';
export { CHILD_ROOM, childRoomAuthorizer, registerParentRooms } from './sockets.js';
export { parentLinks, usableSchool } from './schools.js';
