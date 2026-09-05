import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { useNavigate } from "react-router";

export default function NotFound() {
  const navigate = useNavigate();
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="flex min-h-screen flex-col items-center justify-center bg-background px-6 text-foreground"
    >
      <Brand />
      <div className="mt-10 text-center">
        <p className="tnum font-mono text-7xl font-black tracking-tight text-primary">
          404
        </p>
        <h1 className="mt-4 text-xl font-bold tracking-tight">
          This ticker doesn&apos;t exist
        </h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-muted-foreground">
          The page you&apos;re after isn&apos;t on any of the ten symbol
          charts. Head back to the terminal.
        </p>
        <Button
          type="button"
          className="mt-6"
          onClick={() => navigate("/dashboard")}
        >
          Back to dashboard
        </Button>
      </div>
    </motion.div>
  );
}
