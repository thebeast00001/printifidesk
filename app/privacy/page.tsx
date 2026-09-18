import { Contact, H2, LegalPage } from "@/components/legal/legal-page";
import { canonical } from "@/lib/seo";

export const metadata = {
  title: "Privacy policy",
  description: "What Printifi collects, what it does with it, who can see your files, and for how long.",
  alternates: { canonical: canonical("/privacy") },
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
      sub="What Printifi collects, what it does with it, who can see your files, and for how long."
    >
      <p>
        Printifi is a campus printing service. You upload a document, a print desk near you prints it, and
        you collect it with a token. To do that, Printifi handles a small amount of information about you
        and, for a few hours, the files you send. This page says exactly what, and why.
      </p>

      <H2>What Printifi collects</H2>
      <p>
        <b>Your account.</b> Students sign in with Google; Printifi receives your name, your email address
        and your Google profile picture, and nothing else from Google. People who run a print desk sign in
        with an email address and a password. Sign-in is handled by Clerk, which holds your credentials;
        Printifi stores only your account&apos;s identifier, name and email.
      </p>
      <p>
        <b>Your profile.</b> Anything you choose to add in Settings — phone number, roll number, department,
        hostel and room. All of it is optional. A phone number is used only to send you WhatsApp updates if
        you turn those on.
      </p>
      <p>
        <b>Your orders.</b> Which desk you ordered from, the files, the print settings, the price, how you
        chose to pay, the timeline of the order, any correction the desk sent and your answer to it, and any
        messages the desk sends you about it.
      </p>
      <p>
        <b>Your cash standing.</b> If you pay cash, your account keeps the count of cash orders you collected
        (which sets your cash limit), the count you didn&apos;t collect, any dues from an uncollected order,
        and whether cash is switched off for a while. These are the rules described in the terms, kept as
        numbers on your account so every desk applies them the same way.
      </p>
      <p>
        <b>Your files.</b> The documents you upload, up to 50 MB each and 500 MB of live files per account.
        The page count, and which pages contain colour, are worked out in your browser before upload to
        price the job. A Word, PowerPoint or Excel file is converted to a PDF by a converter Printifi runs;
        the original is deleted once the PDF exists, and the PDF is measured in your browser like any other.
      </p>
      <p>
        <b>The cover sheet.</b> When the desk opens your file to print it, Printifi makes a copy with a
        labelled first page — your token, your first name and initial, the page count and settings, the
        file name, the shelf slot, and whether cash is owed. It carries no phone number, email, roll number
        or pickup code. That copy is stored beside your file and deleted with it.
      </p>
      <p>
        <b>Notifications.</b> If you turn on notifications, your browser gives Printifi a push subscription
        — an address the browser vendor uses to deliver a message to that device. It carries no personal
        information.
      </p>
      <p>
        <b>Payments through Printifi.</b> If you pay through Printifi (&ldquo;Pay · UPI, card&rdquo;), or pay
        dues online, Printifi&apos;s payment partner receives your name, email and phone number with the
        payment, as payment law requires. Printifi stores the partner&apos;s order and payment references and
        the amount; it never sees your card, bank or UPI details. Paying the desk directly involves Printifi
        in nothing.
      </p>
      <p>
        <b>Nothing else.</b> There are no advertising trackers, no analytics scripts and no third-party
        cookies. The only cookies are the sign-in session and your light/dark theme choice. Search engines
        are told about the public pages of this site and nothing about you.
      </p>

      <H2>Who can see your files</H2>
      <p>
        Only you, and the desk you ordered from. The desk can open a file only while the order is live —
        from the moment you place it until it is collected or cancelled — and every time the desk opens a
        file, that access is recorded against your order. A link to a file expires five minutes after it is
        made. No other desk, no other student, and nobody browsing Printifi as a user can read your
        documents; the database enforces this row by row, not the app.
      </p>

      <H2>How long things are kept</H2>
      <p>
        <b>Files</b> are deleted automatically six hours after your order is collected. Files you keep in
        your <i>Stored</i> library stay until you delete them from Settings, within the 500 MB limit.
      </p>
      <p>
        <b>Orders</b> — the token, the price, the timeline, the payment references — are kept as the record
        of what was printed and paid, for you and for the desk. So are records of dues and of Printifi
        covering a desk for an uncollected order: they are the accounts between you, the desk and Printifi.
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
        your order is live. On the cover sheet it prints, your first name and initial. If you settle dues
        in cash at a desk, that desk sees your name and the amount owed, and nothing else about your
        account. A screen at the counter may show your token; it shows nothing else.
      </p>

      <H2>What the runner sees about you</H2>
      <p>
        If you choose delivery, the hostel and room you give are kept on your profile (so they&apos;re there
        next time) and copied onto that order. Printifi&apos;s runner — a person Printifi has approved by
        name — sees your name, phone number, hostel and room for the jobs waiting on a shelf and the ones in
        their hands, and for a day afterwards the ones they delivered; never the code in your QR, which is
        what they scan at your door, and nothing about any other order. Whether a delivery was handed over
        against your code or on the runner&apos;s word is recorded on the order. The cover sheet on a
        delivery carries the hostel and room, so the runner can read the pile.
      </p>

      <H2>Payments</H2>
      <p>
        Most orders are paid to the desk directly — by UPI to the desk&apos;s own account, or in cash at the
        counter — and Printifi never handles that money. Where a desk takes payment through Printifi,
        Printifi&apos;s payment partner, Cashfree Payments, takes it; Printifi keeps its platform fee and
        pays the desk the rest, and both sides see the same statement. Dues from an uncollected cash order
        are paid to Printifi the same way, or in cash at any desk. Cash taken at your door by Printifi&apos;s
        runner is Printifi&apos;s to hold; the desk is credited its price for the job. The price you see
        includes Printifi&apos;s platform fee, where the desk uses one the cover sheet, and — if you chose
        it — the delivery fee as its own line.
      </p>

      <H2>Services Printifi runs on</H2>
      <p>
        <b>Clerk</b> for sign-in. <b>Supabase</b> for the database and file storage. <b>Vercel</b> for
        hosting. <b>Google</b> for student sign-in. <b>Cashfree Payments</b> only when you pay through
        Printifi. A document converter Printifi hosts itself, for Word, PowerPoint and Excel files. Your
        browser&apos;s vendor (Google, Apple, Mozilla) for delivering push notifications. <b>WhatsApp</b>
        only if you turn WhatsApp updates on, and only for the messages you asked for. Each of these
        processes data on Printifi&apos;s behalf to provide the service, and for nothing else.
      </p>

      <H2>Your choices</H2>
      <p>
        Turn notifications on or off in Settings. Delete stored files in Settings. Leave any profile field
        empty. Sign out from your profile. Ask for your account to be removed.
      </p>

      <H2>Who this is for</H2>
      <p>
        Printifi is built for college students and the print desks that serve them. It is not intended for
        anyone under 16.
      </p>

      <H2>Changes</H2>
      <p>
        If what Printifi collects or does changes, this page changes and the date at the top moves. Nothing
        is collected that isn&apos;t described here.
      </p>

      <H2>Contact</H2>
      <Contact />
    </LegalPage>
  );
}
