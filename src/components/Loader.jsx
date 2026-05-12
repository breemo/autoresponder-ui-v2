import React from "react";

export default function Loader({ text = "Loading..." }) {
  return (
    <div className="fixed inset-0 flex flex-col justify-center items-center bg-white/80 backdrop-blur-sm z-50">
      <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mb-4"></div>
      <p className="text-gray-600 font-medium text-sm">{text}</p>
    </div>
  );
}
