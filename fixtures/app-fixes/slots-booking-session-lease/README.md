# Good app repair: independent session leases

Copy these files over `examples/slots-booking/web/` on the app-fix candidate branch.
Each login creates an Upstash-backed five-minute lease. Booking atomically consumes its own lease.
A later login no longer invalidates an earlier valid session.
