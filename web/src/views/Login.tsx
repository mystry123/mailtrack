export function Login({ error }: { error: string | null }) {
  return (
    <div className="login">
      <div className="card login-card">
        <div className="brand big">
          <span className="brand-mark" aria-hidden>
            ✈
          </span>
          Mailtrack
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
