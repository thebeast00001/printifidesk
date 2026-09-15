-- Print Counter — the shop's own QR, kept as it was printed.
--
-- Run after 0030.
--
-- Some merchant ids only take money through their own QR. Paytm's are the
-- clearest case: a @pty / @paytm merchant id refuses a link with the
-- amount in it and refuses "pay to UPI id" typed into another app — the
-- apps answer "our banking partner is unable to process your request" —
-- and accepts nothing but a scan of the standee, which is signed by Paytm.
-- So when a desk reads its standee in from a photo, the QR's exact text is
-- kept here, and the pay sheet can draw that QR — the shop's own, signature
-- and all — for the student to scan or to open from their gallery. Only
-- ever the standee's text, which is public by design.

alter table public.operators add column if not exists upi_qr text
  check (upi_qr is null or (length(upi_qr) between 20 and 2000));
