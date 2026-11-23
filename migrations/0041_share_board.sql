-- 0041: a shared board as its maker saw it (src/api/collage.js createShare, src/share-page.js). A share's picture is the
-- board plus a band of the wall around it; these say where the board is in that picture and what it is made of, frozen
-- with the share, so its page draws the same board on the same wall.
--   board_x, board_y, board_w, board_h   the board's rectangle, as fractions of the picture's width and height
--   board_scale    the picture's pixels per board unit (a board's sizes, a frame's width and a material's grain are in
--                  board units: public/js/shared/board-look.js)
--   board_ground   its material: corkboard | paper | linen | slate | fridge
--   collage_share_items.pin   which fastener holds that photograph, and where it sits: the app's own stream for it
--                  (public/js/shared/fasteners.js fastHash, an unsigned 32-bit number), so the page pins each photograph
--                  as the app does
-- All six or none (sent as bx, by, bw, bh, bs, bg); pin with each photograph. A share made before has none: its page
-- draws its whole picture as the board, on the wall, and pins each photograph by its place on the board.
-- Columns with no default that only the new routes read: an old Worker reads past them, so it may go before the deploy.
ALTER TABLE collage_shares ADD COLUMN board_x REAL;
ALTER TABLE collage_shares ADD COLUMN board_y REAL;
ALTER TABLE collage_shares ADD COLUMN board_w REAL;
ALTER TABLE collage_shares ADD COLUMN board_h REAL;
ALTER TABLE collage_shares ADD COLUMN board_scale REAL;
ALTER TABLE collage_shares ADD COLUMN board_ground TEXT;
ALTER TABLE collage_share_items ADD COLUMN pin INTEGER;
