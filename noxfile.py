import nox

nox.options.default_venv_backend = "uv"


@nox.session
def sync(session):
    """Sync roadmap data from GitHub Project Board."""
    session.install("-r", "requirements.txt")
    session.run("python", "scripts/sync_roadmap.py")


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


@nox.session(name="sync-and-docs")
def sync_and_docs(session):
    """Sync roadmap then build docs (for CI)."""
    sync(session)
    docs(session)
