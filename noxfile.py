import nox

nox.options.default_venv_backend = "uv"

@nox.session
def docs(session):
    """Build MyST documentation site."""
    session.install("-r", "requirements.txt")
    with session.chdir("docs"):
        session.run("myst", "build", "--html")


@nox.session(name="docs-live")
def docs_live(session):
    """Start MyST development server with live reload."""
    session.install("-r", "requirements.txt")
    with session.chdir("docs"):
        session.run("myst", "start")


@nox.session
def clean(session):
    """Remove MyST build assets and start fresh."""
    session.install("-r", "requirements.txt")
    with session.chdir("docs"):
        session.run("myst", "clean", "-y", "-a")