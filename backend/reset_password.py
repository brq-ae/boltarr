"""Forgot the password? Turns login off so a new one can be set in Settings.

    docker exec -it boltarr reset-password
    (outside Docker: python -m backend.reset_password)
"""
from .auth import clear_password


def main() -> None:
    clear_password()
    print("Boltarr login is now off and every browser is logged out.\n"
          "Open Boltarr and set a new password in Settings → Login.")


if __name__ == "__main__":
    main()
