-- Model upstream's survey rating: a submitted survey records `{status: "submitted", rating, at}` (rating 1-5).
-- Existing rows predate the column, so their rating stays null until the next account refresh.
ALTER TABLE surveys ADD COLUMN rating INTEGER;
