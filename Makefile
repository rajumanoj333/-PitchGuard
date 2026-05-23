.PHONY: help setup backend console simulator deploy clean

help:
	@echo "PitchGuard targets:"
	@echo "  make setup      - bootstrap GCP (one-time)"
	@echo "  make backend    - run brain locally on :8080"
	@echo "  make console    - run console locally on :3000"
	@echo "  make simulator  - pump synthetic signals at brain"
	@echo "  make deploy     - deploy backend + console to GCP"
	@echo "  make clean      - remove build artifacts"

setup:
	bash infra/setup.sh

backend:
	cd backend && pip install -q -r requirements.txt && \
	GOOGLE_CLOUD_PROJECT=pitchguard uvicorn main:app --reload --port 8080

console:
	cd console && npm install && npm run dev

simulator:
	cd simulator && pip install -q -r requirements.txt && \
	python simulate.py --brain http://localhost:8080 --rate 2

deploy:
	bash infra/deploy.sh

clean:
	rm -rf console/.next console/out backend/__pycache__ simulator/__pycache__
