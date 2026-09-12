import { Contact, H2, LegalPage } from "@/components/legal/legal-page";

export const metadata = {
  title: "Privacy policy",
  description: "What Printify collects, what it does with it, who can see your files, and for how long.",
};

/**
 * Every sentence here describes what the code actually does. When the code
 * changes, this page changes with it — it is part of the product, not a
 * template.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      sub="What Printify collects, what it does with it, who can see your files, and for how long."
    >
      <p>
        Printify is a campus printing service. You upload a document, a print desk near you prints it, and
        you collect it with a token. To do that, Printify handles a small amount of information about you
        and, for a few hours, the files you send. This page says exactly what, and why.
      </p>

      <H2>What Printify collects</H2>
      <p>
        <b>Your account.</b> Students sign in with Google; Printify receives your name, your email address
        and your Google profile picture, and nothing else from Google. People who run a print desk sign in
        with an email address and a password. Sign-in is handled by Clerk, which holds your credentials;
        Printify stores only your account&apos;s identifier, name and email.
      </p>
      <p>
        <b>Your profile.</b> Anything you choose to add in Settings — phone number, roll number, department,
        hostel and room. All of it is optional. A phone number is used only to send you WhatsApp updates if
        you turn those on.
      </p>
      <p>
        <b>Your orders.</b> Which desk you ordered from, the files, the print settings, the price, the
        payment method and the UPI reference you type in, the timeline of the order, and any messages the
        desk sends you about it.
      </p>
      <p>
        <b>Your files.</b> The documents you upload, up to 50 MB each and 500 MB of live files per account.
        The page count, and which pages contain colour, are worked out in your browser before upload to
        price the job.
      </p>
      <p>
        <b>Notifications.</b> If you turn on notifications, your browser gives Printify a push subscription
        — an address the browser vendor uses to deliver a message to that device. It carries no personal
        information.
      </p>
      <p>
        <b>Nothing else.</b> There are no advertising trackers, no analytics scripts and no third-party
        cookies. The only cookies are the sign-in session and your light/dark theme choice.
      </p>

      <H2>Who can see your files</H2>
      <p>
        Only you, and the desk you ordered from. The desk can open a file only while the order is live —
        from the moment you place it until it is collected or cancelled — and every time the desk opens a
        file, that access is recorded against your order. A link to a file expires five minutes after it is
        made. No other desk, no other student, and nobody browsing Printify as a user can read your
        documents; the database enforces this row by row, not the app.
      </p>

      <H2>How long things are kept</H2>
      <p>
        <b>Files</b> are deleted automatically six hours after your order is collected. Files you keep in
        your <i>Stored</i> library stay until you delete them from Settings, within the 500 MB limit.
      </p>
      <p>
        <b>Orders</b> — the token, the price, the timeline, the payment reference — are kept as the record
        of what was printed and paid, for you and for the desk.
      </p>
      <p>
        <b>Your account</b> stays until you ask for it to be removed. Removing it deletes your profile,
        your stored files and your push subscriptions; orders stay in the desk&apos;s records without your
        name attached.
      </p>

      <H2>What the desk sees about you</H2>
      <p>
        Your name and roll number, so the right person collects the right job, and your phone number if you
        added one, so the desk can reach you about a problem with your file. The desk sees these only while
        your order is live.
      </p>

      <H2>Payments</H2>
      <p>
        Printify never handles your money. You pay the desk directly — by UPI to the desk&apos;s own account,
        or in cash at the counter. The price you see includes Printify&apos;s platform fee, which the desk
        later passes on to Printify. Printify does not see your bank or UPI details; the only payment
        information stored is the reference number you choose to type in, so the desk can match your
        payment.
      </p>

      <H2>Services Printify runs on</H2>
      <p>
        <b>Clerk</b> for sign-in. <b>Supabase</b> for the database and file storage. <b>Vercel</b> for
        hosting. <b>Google</b> for student sign-in. Your browser&apos;s vendor (Google, Apple, Mozilla) for
        delivering push notifications. <b>WhatsApp</b> only if you turn WhatsApp updates on, and only for
        the messages you asked for. Each of these processes data on Printify&apos;s behalf to provide the
        service, and for nothing else.
      </p>

      <H2>Your choices</H2>
      <p>
        Turn notifications on or off in Settings. Delete stored files in Settings. Leave any profile field
        empty. Sign out from your profile. Ask for your account to be removed.
      </p>

      <H2>Who this is for</H2>
      <p>
        Printify is built for college students and the print desks that serve them. It is not intended for
        anyone under 16.
      </p>

      <H2>Changes</H2>
      <p>
        If what Printify collects or does changes, this page changes and the date at the top moves. Nothing
        is collected that isn&apos;t described here.
      </p>

      <H2>Contact</H2>
      <Contact />
    </LegalPage>
  );
}
