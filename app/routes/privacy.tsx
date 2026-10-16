import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  return json({ host: url.host });
};

const SECTION_TITLE: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 700,
  margin: "28px 0 8px",
};

const P: React.CSSProperties = {
  fontSize: 15,
  lineHeight: 1.65,
  color: "#333",
  margin: "0 0 12px",
};

const LI: React.CSSProperties = { fontSize: 15, lineHeight: 1.65, color: "#333", marginBottom: 6 };

export default function PrivacyPolicy() {
  const { host } = useLoaderData<typeof loader>();
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Privacy Policy — AdPilot</title>
      </head>
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          margin: 0,
          background: "#f6f6f7",
          color: "#111",
        }}
      >
        <div
          style={{
            maxWidth: 760,
            margin: "0 auto",
            padding: "48px 24px 64px",
            background: "#fff",
          }}
        >
          <h1 style={{ fontSize: 30, margin: "0 0 8px" }}>
            Privacy Policy — AdPilot
          </h1>
          <p style={{ fontSize: 14, color: "#666", margin: "0 0 24px" }}>
            Last updated: October 17, 2026 · App: AdPilot – Social Media Command
            ({host})
          </p>

          <p style={P}>
            AdPilot ("the App") is a Shopify app that helps merchants manage
            their social media presence and advertising. It connects to
            merchants' Facebook Pages, Instagram Business accounts, and Meta ad
            accounts via Meta's official APIs, and provides AI-assisted caption
            writing. This policy explains what data we collect and how it is
            used.
          </p>

          <h2 style={SECTION_TITLE}>1. Data we collect</h2>
          <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
            <li style={LI}>
              <strong>Shopify shop data:</strong> shop domain and basic store
              information provided through the Shopify API when the App is
              installed (needed to operate the App for your store).
            </li>
            <li style={LI}>
              <strong>Facebook / Meta data (only after you connect):</strong>{" "}
              Facebook Page IDs, Page names, Page access tokens, Instagram
              Business account IDs linked to your Pages, and Meta ad account
              IDs, names, and currency — collected through Meta's OAuth flow
              with your explicit permission.
            </li>
            <li style={LI}>
              <strong>Content you create:</strong> post text, images, scheduling
              choices, ad creative settings, audience definitions, and AI
              caption requests you submit in the App.
            </li>
            <li style={LI}>
              <strong>Wallet &amp; usage data:</strong> top-up records and a
              ledger of per-action charges (e.g. published posts, generated
              captions) so we can operate the App's billing correctly.
            </li>
          </ul>

          <h2 style={SECTION_TITLE}>2. How we use the data</h2>
          <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
            <li style={LI}>Publish and schedule the social posts you create, to the Pages you connected.</li>
            <li style={LI}>Create and manage the ad campaigns, audiences, and ad accounts you configure.</li>
            <li style={LI}>Generate caption suggestions you request (content is sent to our AI provider to produce the suggestion).</li>
            <li style={LI}>Operate wallet billing and show your usage history.</li>
            <li style={LI}>Provide customer support when you contact us.</li>
          </ul>
          <p style={P}>
            We do <strong>not</strong> sell your data. We do not share your
            data with third parties except (a) Meta, when you ask the App to
            publish or advertise through Meta's APIs, (b) our AI provider, when
            you request a caption suggestion, and (c) our hosting provider,
            which stores the App's database.
          </p>

          <h2 style={SECTION_TITLE}>3. Data retention</h2>
          <p style={P}>
            Connected account tokens and your content are kept for as long as
            your shop uses the App. If you disconnect a Facebook Page,
            Instagram account, or ad account in the App, its tokens are deleted
            from our database.
          </p>

          <h2 style={SECTION_TITLE}>4. Data deletion</h2>
          <p style={P}>
            You can request complete deletion of your data at any time:
          </p>
          <ul style={{ paddingLeft: 20, margin: "0 0 12px" }}>
            <li style={LI}>
              Email <strong>support@creatorstudioacademy.com</strong> from your
              store's contact email with the subject "Delete my AdPilot data"
              and include your shop domain (e.g.
              your-shop.myshopify.com). We will delete all data associated
              with your shop — connected Meta accounts and tokens, posts,
              wallet history, and AI configurations — within 30 days and
              confirm by email.
            </li>
            <li style={LI}>
              Uninstalling the App from your Shopify store also triggers
              removal of your shop's data from our systems.
            </li>
          </ul>

          <h2 style={SECTION_TITLE}>5. Security</h2>
          <p style={P}>
            Access tokens and API keys are stored encrypted. Connections to the
            App and to Meta's APIs use HTTPS. Access to production data is
            limited to what is needed to operate and support the App.
          </p>

          <h2 style={SECTION_TITLE}>6. Contact</h2>
          <p style={P}>
            For privacy questions or deletion requests:{" "}
            <strong>support@creatorstudioacademy.com</strong>
          </p>
        </div>
      </body>
    </html>
  );
}
