export function Login({ error }: { error: string | null }) {
  return (
    <div className="login">
      <div className="card login-card">
        <div className="brand big">
          <span className="dot" /> Mailtrack
        </div>
        <p className="muted">See who opens your emails and clicks your links.</p>
        {error && <p className="error">{error}</p>}
        <a className="button primary" href="/auth/google">
          Sign in with Google
        </a>
        <p className="fine">Asks permission to send mail as you. It never reads your inbox.</p>
      </div>
    </div>
  );
}
