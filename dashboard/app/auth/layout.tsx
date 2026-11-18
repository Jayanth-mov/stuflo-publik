// Auth screens (sign in / verify) are always light — even if the user's saved
// theme is dark. The data-theme="light" wrapper re-asserts the light tokens.
export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div data-theme="light" className="bg-paper">
      {children}
    </div>
  );
}
