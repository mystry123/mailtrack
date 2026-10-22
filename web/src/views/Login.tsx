export function Login({ error }: { error: string | null }) {
  return (
    <div className="login">
      <div className="card login-card">
        <div className="brand">
          <img src="/app/shotline-mark.svg" alt="" width={24} height={24} />
          <span className="brand-name">Mailtrack</span>
          <span className="brand-by">by Shotline</span>
        </div>
        <p className="muted">Your job search, tracked: who opened, who clicked, who replied, and what to do next.</p>
        {error && <p className="error">{error}</p>}
        <a className="button primary" href="/auth/google">
          Sign in with Google
        </a>
        <p className="fine">Asks to send mail as you and to see reply headers on threads sent from here. It never reads message text.</p>
      </div>
    </div>
  );
}
