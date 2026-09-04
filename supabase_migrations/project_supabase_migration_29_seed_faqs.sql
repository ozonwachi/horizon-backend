-- Bug fix: migration_28 created the `faqs` table empty. Before that,
-- HelpCenterScreen's content was 8 hardcoded question/answer pairs baked
-- into the Flutter app - moving to an admin-editable table (as requested)
-- silently dropped that content instead of carrying it over, so admins
-- opening the new FAQ screen saw a blank list where the app used to show
-- real content. This seeds those same 8 entries as real rows, in their
-- original order, so nothing is lost - from here they're fully editable
-- from AdminFaqsScreen like anything else.
--
-- Guarded to only insert if the table is CURRENTLY EMPTY, so this is safe
-- to run even if an admin has already added/edited FAQs since migration_28 -
-- it will never overwrite or duplicate anything they've done.
--
-- Run this in the Supabase SQL Editor after migration_28.

insert into public.faqs (question, answer, sort_order)
select * from (values
  (
    'How does an escrow deal work?',
    'The buyer funds the deal (from their wallet or by card) and the money is held by Horizon, not sent to the seller directly. Once the buyer confirms the work or item is as agreed, they release the funds and the seller is paid out. A deal can be split into tranches (milestones) that release one at a time instead of all at once.',
    0
  ),
  (
    'What happens if I disagree with the other party?',
    'Either side can dispute a tranche or the whole deal from the deal''s detail screen. That pauses the release and puts it in front of an admin, who reviews the evidence and resolves it - either releasing the funds to the seller or refunding the buyer.',
    1
  ),
  (
    'What is the connection fee?',
    'If you find someone through Horizon but then complete the deal outside the app (cash, bank transfer, another platform), you''re expected to declare and pay a small connection fee from your wallet - it''s how Horizon keeps running. You can pay it any time from the Wallet screen, and either party to a deal can flag one that wasn''t declared.',
    2
  ),
  (
    'What are Basic, Verified, and Trusted Business?',
    'Basic is where every account starts - you can browse, buy, and message. Verified means you''ve completed identity verification (a government ID plus a selfie, reviewed by an admin) - it''s required before you can sell, post a job/service, or post a barter. Trusted Business is a further tier an admin can grant to an established, trustworthy business account. See Trust Center in your profile for the full picture.',
    3
  ),
  (
    'Why do job/opportunity alerts only show some posts?',
    'Alerts are matched to the skills/roles listed on your profile and to your saved notification location - specifically, the same state. A job posted in a different state than your saved location won''t alert you, even if it''s the same country. Update your notification location from your profile if you''ve moved, or change your skill tags if you''re not getting alerts you''d expect.',
    4
  ),
  (
    'How do withdrawals work?',
    'Requesting a withdrawal deducts the amount from your wallet balance immediately and queues it for an admin to pay out to your bank details manually. You''ll be notified once it''s paid - or if it''s rejected, in which case the amount is credited straight back to your wallet.',
    5
  ),
  (
    'I think someone dodged the connection fee on a deal with me. What do I do?',
    'From the Wallet screen, use "File a Deal Integrity Report" - it takes the seller''s username, phone number, and a short description of the deal. This doesn''t affect your account or any transaction; it just gives our team something to look into.',
    6
  ),
  (
    'Something''s wrong and none of this covers it.',
    'Open the deal or listing in question and look for a Contact Admin / support option on it - that opens a conversation an admin can see and reply in directly.',
    7
  )
) as v(question, answer, sort_order)
where not exists (select 1 from public.faqs);
