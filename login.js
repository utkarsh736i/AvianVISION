export default function handler(req, res) {

  if (req.method !== "POST") {
    return res.status(405).json({
      message: "Method not allowed"
    });
  }

  const { email, password } = req.body;

  // Your users database
  const users = [
    {
      email: "admin@company.com",
      password: "admin123",
      role: "admin"
    },
    {
      email: "operator@plant.io",
      password: "plant123",
      role: "operator"
    },
    {
      email: "manager@factory.com",
      password: "manager123",
      role: "manager"
    }
  ];

  const user = users.find(
    u => u.email === email && u.password === password
  );

  if (user) {
    return res.status(200).json({
      success: true,
      role: user.role
    });
  }

  return res.status(401).json({
    success: false,
    message: "Invalid credentials"
  });
}