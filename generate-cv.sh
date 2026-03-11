#!/bin/bash

# Script de generation des CV en PDF
# Usage: ./generate-cv.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Generation des CV en PDF..."

# CV Francais
echo "- Generation du CV francais..."
wkhtmltopdf --enable-local-file-access --page-size A4 --margin-top 0 --margin-bottom 0 --margin-left 0 --margin-right 0 cv-theo-lambert.html cv-theo-lambert-temp.pdf 2>/dev/null
qpdf cv-theo-lambert-temp.pdf --pages . 1 -- cv-theo-lambert.pdf
rm cv-theo-lambert-temp.pdf
echo "  -> cv-theo-lambert.pdf genere"

# CV Anglais
echo "- Generation du CV anglais..."
wkhtmltopdf --enable-local-file-access --page-size A4 --margin-top 0 --margin-bottom 0 --margin-left 0 --margin-right 0 cv-theo-lambert-en.html cv-theo-lambert-en-temp.pdf 2>/dev/null
qpdf cv-theo-lambert-en-temp.pdf --pages . 1 -- cv-theo-lambert-en.pdf
rm cv-theo-lambert-en-temp.pdf
echo "  -> cv-theo-lambert-en.pdf genere"

echo ""
echo "Termine! Les fichiers PDF ont ete generes."
