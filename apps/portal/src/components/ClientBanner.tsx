// SPDX-License-Identifier: PolyForm-Small-Business-1.0.0
//
// P76: the client's link from another service at the top of their home page: its message and a
// button opening the link in a new tab. Also in the staff preview of the portal (P77).

export interface ClientLinkValue {
  url: string;
  message: string;
  button: string;
}

export function ClientLinkBanner({ link }: { link: ClientLinkValue }): JSX.Element | null {
  // Only a web address: the server takes no other kind, and none is ever put in the page.
  if (!/^https?:\/\//i.test(link.url)) return null;
  return (
    <aside className="p-banner" aria-label="From your firm">
      <p className="p-banner-text">{link.message}</p>
      <a className="p-banner-button" href={link.url} target="_blank" rel="noopener noreferrer">
        {link.button}
        <span className="visually-hidden"> (opens in a new tab)</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
        </svg>
      </a>
    </aside>
  );
}
