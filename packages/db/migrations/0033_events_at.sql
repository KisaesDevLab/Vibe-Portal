-- SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
--
-- P103: the History page is narrowed by day (From, To), and its CSV reads a range of days:
-- found by this index, not by reading every entry.

CREATE INDEX IF NOT EXISTS events_at_idx ON events (at);
