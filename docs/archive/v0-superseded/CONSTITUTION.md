# WHERE IS MY BUS

> **Deployment context:** private schools, colleges and universities — see `ARCHITECTURE.md` §26 for the nomenclature mapping (State → Institution, Region → Zone, Depot → Campus, Passenger → Rider).

**Final Application Constitution, Architecture, Data Flow & Feature Blueprint**

> Faithful markdown transcription of `where_is_my_bus_final_constitution_architecture(1) (1).pdf`.
> This document is the functional source of truth. Section numbers are referenced as `FRD §n`.

Production-oriented blueprint for a government-bus passenger application with driver-phone/GPS live tracking, hierarchical administration, conflict-safe scheduling, ETA, notifications and aggressive read optimization.

## 1. Product Constitution

The system is a transport operations platform with three primary experiences: passenger discovery/tracking, driver trip execution, and hierarchical administration. The core operational chain is:

`Permanent Stop → Directional Route → Schedule/Trip Instance → Assigned Bus + Driver → Driver Starts Trip → Live GPS → Passenger Tracking/ETA/Notifications`

- Stops are permanent master data with unique IDs, official names and fixed coordinates.
- Routes are directional and consist of ordered permanent stops. Opposite directions are separate route variants.
- A route may be used by many buses and drivers through different schedules.
- A bus and driver are not permanently assigned to one another; assignment is made for a schedule/trip.
- No driver or bus may have overlapping scheduled trips.
- A driver may have multiple trips in a day only when the operational windows do not overlap.
- A scheduled start time never automatically activates a trip. The driver must explicitly start it.
- Only an active trip transmits live GPS and triggers active-trip notifications.
- Cancelled, delayed and suspended states must be represented.
- Cache accelerates reads but never replaces database truth for authorization or resource conflicts.
- Developer/system authority is above administrative authority.

## 2. Roles and Scope

| Role | Scope | Core authority |
|---|---|---|
| Passenger | Public | Search, nearby buses, live trip view, ETA, favorites, notifications, account/settings |
| Driver | Own assignments | View schedule, start/delay/end trip, GPS transmission, operational status |
| Depot Admin | One depot | Manage depot routes, buses, drivers, schedules/trips and depot operations |
| Region Admin | Own region | All permitted regional operations plus depot selection and consolidation |
| State Admin | Whole state | State-wide regional/depot administration and controlled stop management |
| Developer/System | Whole platform | System safety, restrictions, corrections, platform configuration |

## 3. Passenger Application

### Authentication
- Sign up, login and logout.
- Forgot/reset password.
- CAPTCHA or equivalent bot protection for registration/abuse-sensitive flows.
- Secure authenticated sessions/tokens.
- Profile and settings.

### Home and navigation
- From/To search with current-location option.
- Recent searches/options.
- Side panel for profile, favorites, settings and required account actions.
- Logout in the side panel.
- Nearby-bus action.

### Search logic
Search is route-first, not bus-number-first. From is resolved against permanent stops using exact or nearby geographic matching. Candidate routes are filtered using the From stop before To is evaluated. This prevents scanning every route and keeps the search fast.
- Exact stop matches rank first.
- Nearby stops can be accepted using latitude/longitude and a configured proximity threshold.
- Current location uses the same stop-resolution logic.
- To is searched only against routes already filtered by From.
- Results distinguish Exact and Likely/nearby matches.
- Passenger responses expose only passenger-relevant data.

### Live passenger experience
- Show the selected bus on its route.
- Highlight the route on the map.
- Move the bus marker as current location changes.
- Show ETA and freshness/last-known timestamp.
- Do not show a trip as live merely because its scheduled time arrived.

### Favorites and notifications
- Save useful routes/trips/schedules.
- Subscribe to appropriate trip notifications.
- Notify on actual driver trip start.
- Support delayed/cancelled/suspended messaging.

## 4. Stops: Foundational Master Data
- Created before route construction and geotagged first.
- Permanent unique internal identifier.
- Official human-readable name assigned by administration.
- Latitude/longitude and optional major/minor classification.
- Created by depot administration under the permitted workflow.
- Reusable by any depot/region after creation.
- Depot admins cannot freely edit/delete established stops.
- State-level authority may edit/delete under controlled authorization and audit.
- Developer/system authority can restrict even state-level operations.
- Map view is used during creation/review.

## 5. Route Architecture
- Depot admins create routes from the permanent stop catalogue.
- Route builder supports manual names/search and ordered stop selection.
- Map displays the route while it is being constructed.
- Route contains ordered route-stop relationships.
- Direction is explicit; reverse direction is a separate route.
- Route can be operated by many bus/driver combinations.
- Historical trip integrity must be preserved when route definitions change.

## 6. Bus and Driver Management

### Drivers
- Manual entry and spreadsheet/Excel bulk import.
- Filterable/searchable table.
- Profile details, attendance and operational history.
- Current, scheduled and past trips.
- Availability/conflict information.

### Buses
- Manual entry and spreadsheet/Excel bulk import.
- Filterable/searchable table.
- Registration and operational details.
- Service/maintenance/fuel history where required.
- Current and past assignments.
- Availability/conflict information.

## 7. Schedule and Trip Architecture
Trip creation uses four simultaneous inputs: **Route | Bus | Driver | Date/Time**. A validity period may create recurring instances for 10 days, 15 days or another configured period.
- Route is selected first.
- Bus and driver lists show eligible resources for the selected time window.
- Creation performs final backend conflict validation even if the UI already filtered the choices.
- Recurring schedules create individual trip instances.
- Each trip has its own lifecycle state and actual start/end timestamps.
- Admins can edit schedules subject to the same conflict rules.
- Driver application shows the driver's schedule.

## 8. Hard Scheduling Rules
- No overlapping trip windows for the same driver.
- No overlapping trip windows for the same bus.
- No overlapping duplicate driver+bus assignment.
- A route can run simultaneously with multiple different bus/driver combinations if resources are distinct.
- An occupied bus/driver must not appear available for conflicting times.
- Availability returns after the prior trip ends.
- Final conflict checks must be transactional to prevent two administrators creating a race-condition conflict.

## 9. Trip Lifecycle

`SCHEDULED → DELAYED (optional) → ACTIVE → COMPLETED`

Terminal/interruption states include `CANCELLED` and `SUSPENDED`. A clock reaching the planned start time does not activate the trip.
- Scheduled: planned.
- Delayed: planned start passed or delay recorded.
- Active: driver explicitly starts; GPS and active notifications begin.
- Completed: driver ends trip or valid completion is recorded.
- Cancelled: trip will not operate.
- Suspended: operation is temporarily held.

## 10. Driver GPS Architecture
- Driver logs in and sees only own operational schedule.
- Driver starts the assigned trip.
- Backend verifies driver, trip, bus and authorization.
- Only then does the client transmit GPS.
- Location payload should contain active trip/session identity, latitude, longitude and timestamp plus only essential telemetry.
- Current trip state is updated efficiently; historical telemetry is sampled/retained according to policy.
- Network loss must not fabricate movement; last-known location includes freshness timestamp.
- Driver ending the trip stops live transmission.

## 11. Backend Architecture
- Node.js + Express API layer.
- Authentication and authorization middleware.
- Thin controllers.
- Domain services containing business rules.
- Transactional database layer and migrations.
- Central error/not-found handling.
- Dedicated passenger-search, location, ETA, scheduling, admin and authorization services.
- Routes never become the place for complex business logic.

## 12. Data Model
- State, Region, Depot.
- User/Admin/Role and scoped authorization.
- Passenger Profile.
- Driver.
- Bus.
- Stop.
- Route and ordered RouteStop relationship.
- Schedule.
- Trip Instance.
- Trip Assignment.
- Current Live Location/Trip State.
- ETA state/data.
- Favorites.
- Notification subscriptions/events.
- Audit Log.

Key relationship: `Route → Schedule → Trip Instance → Bus + Driver assignment → Active Trip → Live Location`. Stops are reusable master data referenced by routes.

## 13. Administrative Hierarchy
- Depot Admin is restricted to one depot and cannot read/write other depots.
- Region Admin can select any depot inside the region and operate within that scope, plus regional consolidation.
- State Admin can select regions and depots and perform state-wide permitted operations.
- Every protected API derives scope from authenticated identity; client-supplied IDs cannot grant extra authority.
- Administrative mutations are auditable.

## 14. Caching and Low-Traffic Design
- Cache stop catalogue and other slowly changing master data.
- Cache route definitions and depot metadata.
- Cache admin list/detail reads with targeted invalidation after mutations.
- Cache driver schedules because they are read-heavy and change less frequently than GPS.
- Cache passenger route/trip metadata separately from live location.
- Short-lived cache passenger search results when service-date and location inputs permit safe reuse.
- Never cache authorization in a way that survives permission changes incorrectly.
- Never use cache as final truth for scheduling conflicts.
- Live GPS updates only current-trip state and controlled history; passenger refreshes do not write GPS.
- Use pagination, field-limited responses and bounded payloads everywhere.
- Use TTL and targeted invalidation rather than long-lived indiscriminate cache.

## 15. ETA
- Use route order, current bus position and operational timing data.
- Recalculate when underlying state changes rather than on every UI repaint.
- Use short-lived ETA snapshots.
- Expose stale-location/freshness information.
- Do not imply precision unsupported by the data.

## 16. Admin Panel
- Scoped dashboard.
- Stops.
- Map-assisted routes.
- Drivers and driver profiles.
- Buses and bus/service profiles.
- Schedules and trips.
- Driver schedules.
- Trip monitoring/status.
- Region/depot selectors for higher-level admins.
- Notifications/operational events.
- Audit/history.
- Tables support filtering, sorting and pagination.

## 17. Driver App
- Secure login.
- Upcoming/current schedule.
- Assigned route and stop sequence.
- Start trip.
- Delay/status controls where authorized.
- GPS permission/status.
- End trip.
- Past history where required.

## 18. API and Security Principles
- Versioned APIs where appropriate.
- Consistent response/error envelopes.
- Server-side validation.
- Authentication plus geographic-scope authorization on protected resources.
- Idempotency for safe repeatable operations.
- Pagination and compact responses.
- Rate limiting for auth and abuse-sensitive APIs.
- Dedicated live-location path.
- Consistent timezone/timestamp handling.
- Password hashing, secure tokens/sessions and secrets outside source control.
- Audit logs for sensitive admin mutations.

## 19. Reliability / No-Crash Architecture
- Central error handling and not-found handling.
- Async-safe controllers.
- Database transactions for schedule/resource assignment.
- Indexes and constraints for critical identifiers and conflict checks.
- Graceful stale-GPS/network handling.
- Health/readiness endpoints.
- Structured logs without secrets.
- Frontend loading/error/empty states.
- Safe retries only; never blindly retry trip creation.
- Rate limiting/backpressure on high-frequency location ingestion.
- Automated tests for authorization, scheduling conflicts and trip lifecycle.

## 20. Bulk Import
- Upload spreadsheet for drivers/buses.
- Validate headers, required fields, types and duplicate identifiers.
- Stage before commit.
- Return invalid-row report.
- Commit valid rows transactionally or in controlled batches.
- Never silently overwrite records without an explicit policy.
- Audit imports.

## 21. End-to-End Data Flows

### Passenger search
From input → exact/nearby stop resolution → route filter → To resolution within candidate routes → scheduled trip lookup → Exact/Likely ranking → compact result → selected trip → route/current state → live updates if ACTIVE.

### Operational trip
Admin schedule → transactional resource validation → trip instances → driver schedule → driver START → backend validates assignment → ACTIVE → GPS → current-state cache → passenger live map/ETA → driver END → COMPLETED → GPS stops.

## 22. Recommended Technology
- React + Vite for passenger, admin and driver frontends.
- Node.js + Express backend, consistent with the existing codebase.
- PostgreSQL or another transactional relational database suited to geospatial/scheduling constraints.
- Redis when shared caching/realtime scaling is needed; simple in-process cache only for constrained single-instance development.
- WebSocket/SSE for efficient live updates where useful; controlled polling remains acceptable for an MVP.
- Map/geolocation provider selected according to deployment needs; permanent stop coordinates are stored after validation.
- Background jobs/queues for notifications/imports when scale requires them.

## 23. Current Git Baseline
The project was deliberately reset to a fresh Git root commit: 37d304a — Initial working application, created from the previously verified 9bb7c8e application state. Before the fresh-history reset, the selected baseline passed backend syntax, controller loading, route loading, passenger frontend build and admin frontend build checks.

This means the commit is a working development foundation, not a claim that every feature in this constitution is already implemented. The new history is intentionally clean so all future work can be built against this constitution.

## 24. Baseline vs Target

| Area | Current foundation | Required completion |
|---|---|---|
| Project/backend structure | Established | Keep modular and service-based |
| Passenger UI | Build-tested foundation | Complete account/search/live/favorites/notifications |
| Admin UI | Build-tested foundation | Complete hierarchy and operations |
| Driver UI | Target defined | Implement operational schedule/GPS lifecycle |
| Stops | Foundation | Complete geotagged master-data workflow |
| Routes | Foundation | Complete map-assisted route builder |
| Drivers/Buses | Foundation | Complete CRUD/import/profile/history |
| Schedules/Trips | Foundation | Complete conflict-safe scheduling/lifecycle |
| GPS/ETA | Foundation | Complete realtime pipeline and freshness |
| Notifications | Defined | Implement actual-start/status notifications |
| Caching | Requirement | Implement targeted cache + invalidation |
| Security/reliability | Foundation | Harden and test |

## 25. Recommended Build Order
- Freeze this constitution and data model.
- Build/verify database migrations and constraints.
- Implement stop creation/geotagging and controlled authorization.
- Implement map-assisted route creation.
- Complete bus/driver master data and imports.
- Implement schedule/trip creation with transactional overlap prevention.
- Implement driver schedule and explicit start/end lifecycle.
- Implement minimal GPS ingestion/current-trip state.
- Implement route-first passenger search.
- Implement live map and ETA.
- Implement favorites and actual-start notifications.
- Complete admin hierarchy and consolidation.
- Add caching/invalidation, pagination and rate limits.
- Add automated and end-to-end tests.
- Run production-style reliability/security testing before deployment.

## 26. Final Definition of Done
- Passenger can securely register/login and search from/to.
- Exact and nearby stop matching works efficiently.
- Routes are directional and map-visible.
- Admins can manage only their authorized geographic scope.
- Stops are reusable permanent master data with controlled higher-level editing.
- Schedules can use any valid bus/driver combination.
- No overlapping driver or bus assignments are possible.
- Drivers can have multiple sequential daily trips.
- Trips activate only after driver start.
- Only active trips transmit GPS.
- Passenger sees live bus, route and ETA with freshness.
- Notifications trigger on actual trip start/status.
- Delayed/cancelled/suspended states work.
- Admin tables are filterable, sortable and paginated.
- Bulk imports validate and audit.
- Caching reduces load without compromising truth or authorization.
- Network/GPS/API failures do not crash the application.
- Critical business rules are automated-test protected.
- Production builds, monitoring and security controls are in place.

## 27. Final Constitutional Principle
Do not let implementation convenience violate the transport model. The authoritative model is permanent stops and directional routes, time-bound schedule assignments, explicit driver-started trips, and live GPS only for active trips. All future features should be evaluated against this model before code is added. This is the safeguard against the route/controller/data-structure drift that caused the earlier cleanup cycle.
