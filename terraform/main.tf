# Durable infrastructure only. The Worker script, Durable Object migrations, and
# D1 table migrations are managed by Wrangler (see worker/), because the Cloudflare
# Terraform provider has known bugs applying DO migrations (#5701, #5898).

resource "cloudflare_r2_bucket" "videos" {
  account_id = var.account_id
  name       = var.bucket_name
  location   = var.location_hint
}

resource "cloudflare_d1_database" "metadata" {
  account_id = var.account_id
  name       = var.database_name
}
